import type { LLMAdapter } from "./llm";
import type {
	SynthesisCache,
	TriageResult,
	VideoRecord,
	VideoVerdict,
} from "./types";

/** Run counts surfaced to the caller for the post-sync Notice. */
export interface TriageRunStats {
	total: number;
	computed: number; // verdicts freshly produced by the LLM this run
	reused: number; // verdicts reused from cache (unchanged signature)
	failed: number; // videos whose verdict failed to parse, skipped
}

// --- Shapes the LLM is asked to return (validated before use) ---

interface RawVerdict {
	verdict: "watch" | "skip";
	likelyTopic: string;
	reason: string;
}

interface RawPile {
	recurringThemes: string[];
	safeToDelete: string[];
}

/**
 * Why a parse attempt yielded nothing usable. "invalid-json" and "empty"
 * (syntactically valid JSON but no real value in it) have different causes in
 * the field — weak JSON mode vs. a response with no decision — so they are
 * reported separately. Generic over the parsed payload so per-video and
 * cross-pile parsing share the same defensive shape.
 */
type ParseOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "invalid-json" }
	| { kind: "empty" };

/**
 * Cap on how many characters of a video description to send per request. Some
 * descriptions are enormous (chapter lists, link dumps); small-context models
 * reject oversized prompts, so truncate. Local to the engine so it stays free
 * of any dependency on the I/O layer.
 */
const MAX_DESCRIPTION_CHARS = 8000;

const VERDICT_SYSTEM_PROMPT = [
	"You are a YouTube watch-later triage engine. You are given the available",
	"metadata for ONE saved video — title, channel, duration, published date, and",
	"(when present) its description. Decide whether it is worth the user's time to",
	"watch, or whether they can skip it.",
	"",
	"Base your decision ONLY on the metadata provided. Do NOT invent facts about",
	"the video's content. When the metadata is thin (for example no title, no",
	"channel, or no description), say so plainly in the reason and treat your",
	"confidence as LOW — do NOT fabricate a confident verdict from nothing.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "verdict": "watch" | "skip",',
	'  "likelyTopic": string,',
	'  "reason": string',
	"}",
	"",
	"Rules:",
	'- "verdict" is exactly "watch" or "skip".',
	'- "likelyTopic" is a short lowercase topic label (1-4 words) inferred from',
	'  the metadata; use "unknown" when there is not enough signal.',
	'- "reason" is ONE short sentence justifying the verdict. If the metadata is',
	"  thin, the reason MUST state that confidence is low.",
	"- Do NOT return a summary of the video — this is a triage verdict, not a",
	"  summary.",
].join("\n");

const PILE_SYSTEM_PROMPT = [
	"You are a YouTube watch-later triage engine working across the WHOLE pile of",
	"saved videos at once. You are given each video's id, title, channel, and its",
	"per-video verdict and topic. Identify the themes that recur across multiple",
	"videos, and which videos are safe to delete.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "recurringThemes": string[],',
	'  "safeToDelete": string[]',
	"}",
	"",
	"Rules:",
	'- "recurringThemes" are short lowercase theme labels (1-4 words each) that',
	"  appear across TWO OR MORE videos. Use an empty array when none recur.",
	'- "safeToDelete" is a list of video ids that are low-value to keep. Only',
	'  include ids whose verdict is "skip". Use an empty array when none.',
	"- Use the EXACT video ids given. Do NOT invent ids.",
].join("\n");

/**
 * Owns the synthesis cache and produces a {@link TriageResult} from the
 * watch-later pile.
 *
 * The engine is deliberately free of any Obsidian Plugin API: it never touches
 * the vault, settings, files, or the network directly. All network goes through
 * the injected {@link LLMAdapter}. It mutates the {@link SynthesisCache} it was
 * constructed with; persisting that cache is the caller's job. It also never
 * asks the clock for "today" — the caller stamps `lastSynced` — so the engine
 * stays deterministic and testable.
 */
export class SynthesisEngine {
	private readonly llm: LLMAdapter;
	private readonly cache: SynthesisCache;

	constructor(llm: LLMAdapter, cache: SynthesisCache) {
		this.llm = llm;
		this.cache = cache;
		// Backfill cache layers for blobs persisted before this shape existed
		// (the type marks them required, but an on-disk blob can predate it).
		if (this.cache.verdicts === undefined) {
			this.cache.verdicts = {};
		}
		if (this.cache.themes === undefined) {
			this.cache.themes = {
				memberSignature: "",
				recurringThemes: [],
				safeToDelete: [],
			};
		}
	}

	/**
	 * Triage the whole pile: a verdict per video (incremental — unchanged videos
	 * reuse their cached verdict), plus cross-pile recurring themes and a
	 * safe-to-delete list (reused while the member set is unchanged). One LLM
	 * call per changed video plus one for the pile synthesis, each with a single
	 * retry on malformed JSON; a video that still fails is warned and skipped and
	 * never aborts the run. The cache is mutated in place; the caller persists it.
	 */
	async triage(
		videos: VideoRecord[]
	): Promise<{ result: TriageResult; stats: TriageRunStats }> {
		const stats: TriageRunStats = {
			total: videos.length,
			computed: 0,
			reused: 0,
			failed: 0,
		};

		const verdicts: VideoVerdict[] = [];
		for (const video of videos) {
			const signature = this.videoSignature(video);
			const cached = this.cache.verdicts[video.videoId];
			if (cached && cached.signature === signature) {
				verdicts.push(cached.verdict);
				stats.reused += 1;
				continue;
			}

			const verdict = await this.verdictFor(video);
			if (!verdict) {
				// Parse failed both attempts — skip, leaving any stale cache entry
				// so the next run retries it.
				stats.failed += 1;
				continue;
			}

			this.cache.verdicts[video.videoId] = { signature, verdict };
			verdicts.push(verdict);
			stats.computed += 1;
			console.log(`[Watch Later Synthesizer] Triaged: ${video.videoId}`);
		}

		// Drop cached verdicts for videos no longer in the pile.
		const seen = new Set(videos.map((v) => v.videoId));
		for (const id of Object.keys(this.cache.verdicts)) {
			if (!seen.has(id)) {
				delete this.cache.verdicts[id];
			}
		}

		// Cross-pile synthesis, reused while the whole member set is unchanged.
		const memberSignature = this.memberSignature(videos);
		let recurringThemes: string[];
		let safeToDelete: string[];
		if (
			memberSignature !== "" &&
			this.cache.themes.memberSignature === memberSignature
		) {
			recurringThemes = this.cache.themes.recurringThemes;
			safeToDelete = this.cache.themes.safeToDelete;
		} else {
			const pile = await this.synthesizePile(videos, verdicts);
			if (pile) {
				recurringThemes = pile.recurringThemes;
				safeToDelete = pile.safeToDelete;
				this.cache.themes = {
					memberSignature,
					recurringThemes,
					safeToDelete,
				};
			} else {
				// Synthesis failed — reuse any prior cached themes rather than
				// wiping them; leave the signature stale so the next run retries.
				recurringThemes = this.cache.themes.recurringThemes;
				safeToDelete = this.cache.themes.safeToDelete;
			}
		}

		return {
			result: { verdicts, recurringThemes, safeToDelete },
			stats,
		};
	}

	// --- Change-detection signatures ---

	/**
	 * djb2 signature over the fields that affect a verdict. Null fields collapse
	 * to "" and a NUL separator keeps "a"+"bc" distinct from "ab"+"c". Identical
	 * signature ⇒ same inputs ⇒ no need to re-call the LLM.
	 */
	private videoSignature(video: VideoRecord): string {
		const parts = [
			video.title,
			video.channel,
			video.duration,
			video.published,
			video.descriptionText,
		].map((field) => field ?? "");
		return this.hash(parts.join(" "));
	}

	/**
	 * Signature of the whole pile: each video's id paired with its per-video
	 * signature, sorted so ordering never affects it. Identical signature ⇒ same
	 * members, none edited ⇒ reuse the cached cross-pile synthesis. "" for an
	 * empty pile (never matches, so an empty pile is not treated as "cached").
	 */
	private memberSignature(videos: VideoRecord[]): string {
		if (videos.length === 0) {
			return "";
		}
		const parts = videos
			.map((v) => `${v.videoId}:${this.videoSignature(v)}`)
			.sort();
		return this.hash(parts.join("|"));
	}

	// --- Per-video verdict ---

	/**
	 * Ask the LLM for one video's verdict. Parses defensively and retries once on
	 * invalid JSON. Returns null (and warns) if both attempts fail — or if the
	 * request itself throws (network/auth) — so the caller can count the failure
	 * without aborting the whole run.
	 */
	private async verdictFor(video: VideoRecord): Promise<VideoVerdict | null> {
		const userPrompt = this.buildVideoPrompt(video);

		try {
			const first = await this.llm.complete(VERDICT_SYSTEM_PROMPT, userPrompt);
			const firstOutcome = this.parseVerdict(first);
			if (firstOutcome.kind === "ok") {
				return this.toVerdict(video, firstOutcome.value);
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but had no usable verdict. " +
						'Return the JSON object with "verdict" set to "watch" or "skip" ' +
						"and a non-empty reason."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(VERDICT_SYSTEM_PROMPT, retryPrompt);
			const secondOutcome = this.parseVerdict(second);
			if (secondOutcome.kind === "ok") {
				return this.toVerdict(video, secondOutcome.value);
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but no usable verdict"
					: "invalid JSON";
			console.warn(
				`[Watch Later Synthesizer] Verdict failed (${reason}) for video: ${video.videoId}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Watch Later Synthesizer] Verdict request failed for video: ${video.videoId}`,
				error
			);
			return null;
		}
	}

	private buildVideoPrompt(video: VideoRecord): string {
		const lines = [
			`Video ID: ${video.videoId}`,
			`URL: ${video.url}`,
			`Title: ${video.title ?? "(unknown)"}`,
			`Channel: ${video.channel ?? "(unknown)"}`,
			`Duration: ${video.duration ?? "(unknown)"}`,
			`Published: ${video.published ?? "(unknown)"}`,
		];
		const description = video.descriptionText
			? video.descriptionText.slice(0, MAX_DESCRIPTION_CHARS)
			: "(no description available)";
		lines.push("", "Description:", description);
		return lines.join("\n");
	}

	/** Stamp the trusted videoId onto a validated LLM verdict. */
	private toVerdict(video: VideoRecord, raw: RawVerdict): VideoVerdict {
		return {
			videoId: video.videoId,
			verdict: raw.verdict,
			likelyTopic: raw.likelyTopic,
			reason: raw.reason,
		};
	}

	private parseVerdict(raw: string): ParseOutcome<RawVerdict> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		const verdict = this.coerceVerdict(value);
		if (verdict === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", value: verdict };
	}

	/** Validate/normalize an arbitrary parsed value into a RawVerdict. */
	private coerceVerdict(value: unknown): RawVerdict | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const raw =
			typeof obj["verdict"] === "string"
				? obj["verdict"].trim().toLowerCase()
				: "";
		const verdict =
			raw === "watch" ? "watch" : raw === "skip" ? "skip" : null;
		if (verdict === null) {
			return null;
		}

		const reason =
			typeof obj["reason"] === "string" ? obj["reason"].trim() : "";
		if (reason === "") {
			return null;
		}

		const likelyTopic =
			typeof obj["likelyTopic"] === "string"
				? obj["likelyTopic"].trim().toLowerCase()
				: "";

		return {
			verdict,
			likelyTopic: likelyTopic === "" ? "unknown" : likelyTopic,
			reason,
		};
	}

	// --- Cross-pile synthesis ---

	/**
	 * Ask the LLM for cross-pile themes and a safe-to-delete list. Same
	 * defensive path as the per-video verdict: safe parse, one retry, and
	 * warn-and-skip (returning null) on a second failure or a thrown request — so
	 * a synthesis failure never aborts the run. An empty pile short-circuits with
	 * no LLM call. `safeToDelete` is filtered down to ids actually marked "skip".
	 */
	private async synthesizePile(
		videos: VideoRecord[],
		verdicts: VideoVerdict[]
	): Promise<{ recurringThemes: string[]; safeToDelete: string[] } | null> {
		if (videos.length === 0) {
			return { recurringThemes: [], safeToDelete: [] };
		}

		const userPrompt = this.buildPilePrompt(videos, verdicts);

		try {
			const first = await this.llm.complete(PILE_SYSTEM_PROMPT, userPrompt);
			const firstOutcome = this.parsePile(first);
			if (firstOutcome.kind === "ok") {
				return this.finalizePile(firstOutcome.value, verdicts);
			}

			const complaint =
				"Your previous output was not valid JSON. Return ONLY the JSON object " +
				'with "recurringThemes" and "safeToDelete" arrays.';
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(PILE_SYSTEM_PROMPT, retryPrompt);
			const secondOutcome = this.parsePile(second);
			if (secondOutcome.kind === "ok") {
				return this.finalizePile(secondOutcome.value, verdicts);
			}

			console.warn(
				`[Watch Later Synthesizer] Pile synthesis failed (invalid JSON). ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				"[Watch Later Synthesizer] Pile synthesis request failed",
				error
			);
			return null;
		}
	}

	private buildPilePrompt(
		videos: VideoRecord[],
		verdicts: VideoVerdict[]
	): string {
		const byId = new Map(verdicts.map((v) => [v.videoId, v]));
		const lines = ["Videos in the watch-later pile:", ""];
		for (const video of videos) {
			const verdict = byId.get(video.videoId);
			const meta = video.channel ? ` — ${video.channel}` : "";
			const decision = verdict
				? ` | verdict: ${verdict.verdict}, topic: ${verdict.likelyTopic}`
				: " | verdict: (none)";
			lines.push(
				`- [${video.videoId}] ${video.title ?? "(unknown title)"}${meta}${decision}`
			);
		}
		return lines.join("\n");
	}

	/**
	 * Keep only safe-to-delete ids that are actually marked "skip" (the engine
	 * never deletes a "watch" video, even if the model lists it).
	 */
	private finalizePile(
		raw: RawPile,
		verdicts: VideoVerdict[]
	): { recurringThemes: string[]; safeToDelete: string[] } {
		const skipIds = new Set(
			verdicts.filter((v) => v.verdict === "skip").map((v) => v.videoId)
		);
		return {
			recurringThemes: raw.recurringThemes,
			safeToDelete: raw.safeToDelete.filter((id) => skipIds.has(id)),
		};
	}

	private parsePile(raw: string): ParseOutcome<RawPile> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		if (typeof value !== "object" || value === null) {
			return { kind: "empty" };
		}
		const obj = value as Record<string, unknown>;
		// Empty arrays are valid: a pile may genuinely have no recurring themes
		// and nothing safe to delete.
		return {
			kind: "ok",
			value: {
				recurringThemes: this.toStringArray(obj["recurringThemes"]),
				safeToDelete: this.toStringArray(obj["safeToDelete"]),
			},
		};
	}

	// --- JSON recovery (shared, ported from the base engine) ---

	/**
	 * Best-effort JSON recovery from a raw model response. Strips code fences,
	 * parses as-is, and if that fails retries on the substring from the first "{"
	 * to the last "}" (weak models often wrap JSON in prose like "Here is the
	 * JSON: {…}"). Returns undefined when nothing parses — a safe sentinel, since
	 * JSON.parse never yields undefined.
	 */
	private extractJsonValue(raw: string): unknown {
		const cleaned = this.stripFences(raw);

		const direct = this.tryParseJson(cleaned);
		if (direct !== undefined) {
			return direct;
		}

		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start !== -1 && end > start) {
			return this.tryParseJson(cleaned.slice(start, end + 1));
		}
		return undefined;
	}

	/** JSON.parse that returns undefined instead of throwing. (JSON.parse
	 * itself can never produce undefined, so it's a safe failure sentinel.) */
	private tryParseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Remove an accidental ```json … ``` wrapper before parsing. */
	private stripFences(raw: string): string {
		let text = raw.trim();
		if (text.startsWith("```")) {
			text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
		}
		return text.trim();
	}

	private toStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter((v) => v !== "");
	}

	/** Small deterministic djb2 hash, rendered as base-36. */
	private hash(input: string): string {
		let h = 5381;
		for (let i = 0; i < input.length; i++) {
			h = (((h << 5) + h) + input.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(36);
	}
}
