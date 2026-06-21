import type { LLMAdapter } from "./llm";
import type {
	Clipping,
	ClipExtraction,
	SynthesisCache,
	ThemeSynthesis,
} from "./types";

/** One new/changed clipping plus its prepared article body (frontmatter
 * stripped and truncated by the caller — the engine never reads files). */
export interface ClippingInput {
	clipping: Clipping;
	body: string;
}

export interface SyncResult {
	extracted: number;
	skipped: number;
	failed: number;
	themes: number;
	themesResynthesized: number;
}

// --- Shape the LLM is asked to return (validated before use) ---

interface RawExtraction {
	summary: string;
	keyClaims: string[];
	topics: string[];
	language?: string;
}

/**
 * Why a parse attempt yielded nothing usable. "invalid-json" and "empty"
 * (syntactically valid JSON but no real value in it) have different causes in
 * the field — weak JSON mode vs. a body the model couldn't read — so they are
 * reported separately. Generic over the parsed payload so extraction and
 * theme synthesis share the same defensive shape.
 */
type ParseOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "invalid-json" }
	| { kind: "empty" };

const EXTRACTION_SYSTEM_PROMPT = [
	"You are a reading-inbox extraction engine. Read the saved web article",
	"and extract its summary, key claims, topics, and language.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "summary": string,',
	'  "keyClaims": string[],',
	'  "topics": string[],',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- "summary" is 2-3 sentences giving a high-level overview of what the',
	"  article is about, written in the article's own language.",
	'- "keyClaims" are 2-4 specific claims, findings, or arguments the article',
	"  makes — each one sentence, in the article's own language. They must add",
	"  concrete detail NOT already stated in the summary; do not restate the",
	"  summary. If the article makes no specific claims, use an empty array.",
	'- "topics" are 2-5 short lowercase category labels (1-3 words each).',
	"  Use BROAD, reusable categories that other articles would also share,",
	"  NOT specific names, products, or events. For example use",
	'  "artificial intelligence" not "claude fable 5"; "climate policy" not',
	'  "the 2026 paris summit"; "personal finance" not "my fidelity account".',
	"  Prefer the most standard, conventional name for each category.",
	'- "language" is the ISO 639-1 code of the article\'s language,',
	'  e.g. "en", "tr", "de".',
	'- If a field is unknown, use an empty array or "" as appropriate.',
	"- Do NOT invent content that is not in the article.",
].join("\n");

const THEME_SYSTEM_PROMPT = [
	"You are a reading-inbox synthesis engine. You are given several sources that",
	"share a common theme — each with its title, summary, and key claims.",
	"Identify what they collectively agree on and where they diverge.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "consensus": string,',
	'  "tension": string,',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- "consensus" is 1-2 sentences: what these sources agree on.',
	'- "tension" is 1-2 sentences: where they disagree or diverge. Use an empty',
	'  string "" when there is no meaningful disagreement — do NOT invent one.',
	'- Write "consensus" and "tension" in the dominant language of the sources.',
	'- "language" is the ISO 639-1 code of that dominant language,',
	'  e.g. "en", "tr", "de".',
	"- Do NOT invent claims the sources do not make.",
].join("\n");

/**
 * Owns the synthesis cache and answers cross-clipping queries.
 *
 * The engine is deliberately free of any Obsidian Plugin API: it never touches
 * the vault, settings, or saveData. It reads clipping bodies that were
 * collected and prepared for it, reaches the network only through the injected
 * {@link LLMAdapter}, and mutates the {@link SynthesisCache} it was
 * constructed with. Persisting that cache is the caller's job. It also never
 * asks the clock for "today" — the caller passes dates in — so the engine
 * stays deterministic and testable.
 */
export class SynthesisEngine {
	private readonly llm: LLMAdapter;
	private readonly cache: SynthesisCache;

	constructor(llm: LLMAdapter, cache: SynthesisCache) {
		this.llm = llm;
		this.cache = cache;
		// Backfill the theme map for caches persisted before Feature 4 (the
		// type marks it required, but an on-disk blob can predate it).
		if (this.cache.themeSyntheses === undefined) {
			this.cache.themeSyntheses = {};
		}
	}

	/**
	 * True when a clipping has no cached extraction, or its file changed since
	 * the cached one (mtime mismatch). The caller uses this to decide which
	 * bodies to read — unchanged clippings never cost a BYOK API call twice.
	 */
	needsExtraction(clipping: Clipping): boolean {
		const existing = this.cache.extractions[clipping.path];
		return existing === undefined || existing.mtime !== clipping.mtime;
	}

	/**
	 * Extract every new/changed clipping, incrementally.
	 *
	 * `allClippings` is the full current inbox (used to drop cache entries for
	 * clippings that vanished from the vault); `inputs` is the subset that
	 * actually needs (re-)extraction, with bodies prepared by the caller. One
	 * LLM call per input, plus at most one retry on malformed JSON; a clipping
	 * that still fails is warned and skipped — its stale cache entry (if any)
	 * is left untouched so the next sync retries it. Never aborts the sync.
	 *
	 * The cache is mutated in place; the caller persists it afterwards.
	 */
	async syncClippings(
		allClippings: Clipping[],
		inputs: ClippingInput[],
		todayISO: string
	): Promise<SyncResult> {
		const result: SyncResult = {
			extracted: 0,
			skipped: allClippings.length - inputs.length,
			failed: 0,
			themes: 0,
			themesResynthesized: 0,
		};

		for (const { clipping, body } of inputs) {
			const extraction = await this.extractClipping(clipping, body);
			if (!extraction) {
				result.failed += 1;
				continue;
			}

			this.cache.extractions[clipping.path] = {
				mtime: clipping.mtime,
				extraction,
			};
			result.extracted += 1;
			console.log(`[Watch Later Synthesizer] Extracted: ${clipping.path}`);
		}

		// Drop cache entries for clippings that no longer exist in the vault.
		const seenPaths = new Set(allClippings.map((c) => c.path));
		for (const path of Object.keys(this.cache.extractions)) {
			if (!seenPaths.has(path)) {
				delete this.cache.extractions[path];
			}
		}

		// Per-theme synthesis runs after every clipping is extracted, so themes
		// see the freshest summaries. A theme failure never aborts the sync.
		const themeResult = await this.syncThemes(allClippings);
		result.themes = themeResult.total;
		result.themesResynthesized = themeResult.resynthesized;

		this.cache.lastSynced = todayISO;
		return result;
	}

	/**
	 * Synthesize each theme (topic shared by 2+ clippings) via one LLM call,
	 * incrementally. A theme is re-synthesized only when its member set or any
	 * member's mtime changed (signature mismatch) — unchanged themes cost zero
	 * tokens. A failed synthesis is warned and skipped, leaving any prior entry
	 * untouched (its stale signature forces a retry next sync). Syntheses for
	 * topics that are no longer themes (dropped below 2 members) are pruned.
	 *
	 * Returns the number of themes currently identified (for the sync Notice).
	 */
	private async syncThemes(
		allClippings: Clipping[]
	): Promise<{ total: number; resynthesized: number }> {
		const themes = this.themesOf(allClippings);
		const activeTopics = new Set(themes.map((t) => t.topic));
		let resynthesized = 0;

		for (const theme of themes) {
			const signature = this.themeSignature(theme.members);
			const cached = this.cache.themeSyntheses[theme.topic];
			if (cached && cached.signature === signature) {
				// Members and their mtimes unchanged — reuse, no API call.
				continue;
			}

			const synthesis = await this.synthesizeTheme(theme.topic, theme.members);
			if (!synthesis) {
				// Leave any prior entry (stale signature) so the next sync retries.
				continue;
			}

			this.cache.themeSyntheses[theme.topic] = { signature, synthesis };
			resynthesized += 1;
			console.log(
				`[Watch Later Synthesizer] Synthesized theme: ${theme.topic}`
			);
		}

		// Prune syntheses for topics that are no longer themes.
		for (const topic of Object.keys(this.cache.themeSyntheses)) {
			if (!activeTopics.has(topic)) {
				delete this.cache.themeSyntheses[topic];
			}
		}

		return { total: themes.length, resynthesized };
	}

	/**
	 * Render the synthesis report as a markdown document. Pure and free: reads
	 * the in-memory cache and the collected clippings — zero LLM calls — and
	 * returns a string; writing it to the vault is the caller's job. `todayISO`
	 * (YYYY-MM-DD) is the caller's clock and anchors the "This week" window and
	 * the stale-clipping cutoff. `staleDays` is clamped to a 7-day floor.
	 */
	buildReportMarkdown(
		clippings: Clipping[],
		todayISO: string,
		staleDays: number
	): string {
		const lines: string[] = [];

		// Newest saved first; undated clippings last ("" sorts after any date
		// in descending order).
		const sorted = [...clippings].sort((a, b) =>
			this.dateKey(b.savedDate).localeCompare(this.dateKey(a.savedDate))
		);
		const extractionOf = (clipping: Clipping) =>
			this.cache.extractions[clipping.path]?.extraction;

		lines.push("# Reading Synthesis");
		lines.push("");
		lines.push(`_Last synced: ${this.cache.lastSynced || "never"}_`);
		lines.push("");

		// --- 1. Reading inbox ---
		lines.push("## Reading inbox");
		if (sorted.length === 0) {
			lines.push("_No clippings found._");
		} else {
			for (const clipping of sorted) {
				const name = this.noteName(clipping.path);
				const extraction = extractionOf(clipping);
				if (!extraction) {
					lines.push(`- [[${name}]] — _not synced yet_`);
					continue;
				}
				const topics =
					extraction.topics.length > 0
						? extraction.topics.join(", ")
						: "no topics";
				const read = extraction.readTimeMinutes
					? ` — ${extraction.readTimeMinutes} min read`
					: "";
				lines.push(`- [[${name}]] — ${topics}${read}`);
			}
		}
		lines.push("");

		// --- 2. Themes (topic grouping is deterministic; the consensus/tension
		// paragraph, when present, comes from cached LLM synthesis — the report
		// itself never calls the LLM and never blocks on missing synthesis). ---
		lines.push("## Themes");
		const themes = this.themesOf(sorted);
		if (themes.length === 0) {
			lines.push("_No shared topics across clippings yet._");
			lines.push("");
		} else {
			for (const theme of themes) {
				lines.push(`### ${theme.topic}`);

				const synthesis = this.cache.themeSyntheses[theme.topic]?.synthesis;
				if (synthesis) {
					lines.push(this.oneLine(synthesis.consensus));
					if (synthesis.tension) {
						lines.push("");
						lines.push(`**Tension:** ${this.oneLine(synthesis.tension)}`);
					}
					lines.push("");
				}

				for (const member of theme.members) {
					const name = this.noteName(member.path);
					const extraction =
						this.cache.extractions[member.path]?.extraction;
					const summary = extraction
						? this.oneLine(extraction.summary)
						: "";
					lines.push(`- [[${name}]] — ${summary}`);
				}
				lines.push("");
			}
		}

		// --- 3. This week ---
		lines.push("## This week");
		const weekStart = this.weekStartOf(todayISO);
		const weekEnd = this.addDays(weekStart, 7);
		const thisWeek = sorted.filter((clipping) => {
			const day = this.dateKey(clipping.savedDate);
			return day !== "" && day >= weekStart && day < weekEnd;
		});
		lines.push(`_Week of ${weekStart}_`);
		lines.push("");
		if (thisWeek.length === 0) {
			lines.push("_Nothing saved this week._");
		} else {
			for (const clipping of thisWeek) {
				const name = this.noteName(clipping.path);
				lines.push(
					`- [[${name}]] — saved ${this.dateKey(clipping.savedDate)}`
				);
			}
		}
		lines.push("");

		// --- 4. Needs attention (stale triage, deterministic) ---
		// Cutoff is "staleDays before today": a clipping saved on or before this
		// date is stale. Floor at 7 days defensively — the setting clamps too,
		// but a hand-edited data.json could carry anything. Lexicographic
		// YYYY-MM-DD comparison, timezone-safe like the week window.
		const today = todayISO.slice(0, 10);
		const staleCutoff = this.addDays(today, -Math.max(7, staleDays));
		const stale = sorted
			.filter((clipping) => {
				const day = this.dateKey(clipping.savedDate);
				// Undated clippings are never stale — don't guess.
				return day !== "" && day <= staleCutoff;
			})
			.sort((a, b) =>
				this.dateKey(a.savedDate).localeCompare(this.dateKey(b.savedDate))
			);
		// Omit the section entirely when nothing is stale.
		if (stale.length > 0) {
			lines.push("## Needs attention");
			for (const clipping of stale) {
				const name = this.noteName(clipping.path);
				const day = this.dateKey(clipping.savedDate);
				const age = this.daysBetween(day, today);
				const extraction = extractionOf(clipping);
				const read = extraction?.readTimeMinutes
					? ` — ${extraction.readTimeMinutes} min read`
					: "";
				lines.push(
					`- [[${name}]] — saved ${day} (${age} days ago)${read}`
				);
			}
			lines.push("");
			lines.push(
				"_These have sat unread for a while — consider reading, archiving, or deleting them._"
			);
			lines.push("");
		}

		// --- 5. Summaries ---
		lines.push("## Summaries");
		const synced = sorted.filter((c) => extractionOf(c) !== undefined);
		if (synced.length === 0) {
			lines.push('_No extractions yet — run "Sync clippings" first._');
		} else {
			for (const clipping of synced) {
				const extraction = extractionOf(clipping);
				if (!extraction) {
					continue;
				}
				lines.push(`### ${this.noteName(clipping.path)}`);
				lines.push(extraction.summary);
				if (extraction.keyClaims.length > 0) {
					// Claims as flowing prose, not bullets.
					lines.push("");
					lines.push(extraction.keyClaims.join(" "));
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	// --- Report internals (all pure) ---

	/**
	 * Group synced clippings into themes by shared topic (exact lowercase
	 * match). Only topics carried by 2+ distinct clippings count as a theme.
	 * Ordered biggest theme first, then alphabetically — fully deterministic.
	 * Shared by the report's Themes section and per-theme synthesis so both
	 * agree on exactly what a theme is.
	 */
	private themesOf(
		clippings: Clipping[]
	): Array<{ topic: string; members: Clipping[] }> {
		const groups = new Map<string, Clipping[]>();

		for (const clipping of clippings) {
			const extraction = this.cache.extractions[clipping.path]?.extraction;
			if (!extraction) {
				continue;
			}
			// Dedupe topics within a clipping so a repeated label can't make one
			// clipping look like two members of the same theme.
			for (const topic of new Set(extraction.topics)) {
				const members = groups.get(topic) ?? [];
				members.push(clipping);
				groups.set(topic, members);
			}
		}

		return [...groups.entries()]
			.filter(([, members]) => members.length >= 2)
			.sort(
				([topicA, a], [topicB, b]) =>
					b.length - a.length || topicA.localeCompare(topicB)
			)
			.map(([topic, members]) => ({ topic, members }));
	}

	/**
	 * Cheap change-detection signature for a theme: a djb2 hash of its member
	 * paths and mtimes, sorted so order never affects it. Identical signature
	 * ⇒ same members, none edited ⇒ no need to re-synthesize.
	 */
	private themeSignature(members: Clipping[]): string {
		const parts = members
			.map((c) => `${c.path}:${c.mtime}`)
			.sort();
		return this.hash(parts.join("|"));
	}

	/**
	 * Monday of the week containing `todayISO`, as YYYY-MM-DD. Sunday belongs
	 * to the previous Monday (steps back 6 days). Pure arithmetic on the
	 * passed-in date via UTC — never reads the clock, and the window check
	 * itself compares YYYY-MM-DD strings lexicographically, so no timezone
	 * parsing can shift the boundary.
	 */
	private weekStartOf(todayISO: string): string {
		const day = todayISO.slice(0, 10);
		const [year, month, date] = day.split("-").map(Number);
		const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
		const daysSinceMonday = dow === 0 ? 6 : dow - 1;
		return this.addDays(day, -daysSinceMonday);
	}

	/**
	 * Add days to a YYYY-MM-DD calendar date, returning YYYY-MM-DD. Arithmetic
	 * runs in UTC so month boundaries and DST never shift the result.
	 */
	private addDays(dateOnly: string, days: number): string {
		const [year, month, day] = dateOnly.split("-").map(Number);
		const dt = new Date(Date.UTC(year, month - 1, day));
		dt.setUTCDate(dt.getUTCDate() + days);
		const y = dt.getUTCFullYear();
		const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
		const d = String(dt.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}

	/**
	 * Whole days from one YYYY-MM-DD calendar date to another (to − from).
	 * UTC millisecond difference, same Date-math approach as {@link addDays},
	 * so timezone and DST never shift the count. Both inputs are assumed to be
	 * valid calendar-date keys (callers pass dateKey output).
	 */
	private daysBetween(fromDay: string, toDay: string): number {
		const [fy, fm, fd] = fromDay.split("-").map(Number);
		const [ty, tm, td] = toDay.split("-").map(Number);
		const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
		return Math.round(ms / 86400000);
	}

	/**
	 * Reduce a date string to its calendar-date key (YYYY-MM-DD) for timezone-
	 * safe lexicographic comparison. Returns "" for missing/invalid dates.
	 */
	private dateKey(date: string | undefined): string {
		const day = (date ?? "").slice(0, 10);
		return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
	}

	/** Vault path → wikilink-friendly note name (drop folders and .md). */
	private noteName(sourcePath: string): string {
		const base = sourcePath.split("/").pop() ?? sourcePath;
		return base.replace(/\.md$/i, "");
	}

	/** Flatten a summary to a single line for list items. */
	private oneLine(text: string): string {
		return text.replace(/\s*\n\s*/g, " ").trim();
	}

	// --- Extraction internals ---

	/**
	 * Ask the LLM to extract one clipping. Parses the response defensively and
	 * retries once on invalid JSON. Returns null (and warns) if both attempts
	 * fail — or if the request itself throws (network/auth) — so the caller
	 * can count the failure without aborting the whole sync.
	 */
	private async extractClipping(
		clipping: Clipping,
		body: string
	): Promise<ClipExtraction | null> {
		const userPrompt = this.buildUserPrompt(clipping, body);

		try {
			const first = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				userPrompt
			);
			const firstOutcome = this.parseExtraction(first);
			if (firstOutcome.kind === "ok") {
				return this.toClipExtraction(clipping, body, firstOutcome.value);
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but contained no summary. " +
						"Return the JSON object with a non-empty summary."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				retryPrompt
			);
			const secondOutcome = this.parseExtraction(second);
			if (secondOutcome.kind === "ok") {
				return this.toClipExtraction(clipping, body, secondOutcome.value);
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but empty extraction"
					: "invalid JSON";
			console.warn(
				`[Watch Later Synthesizer] Extraction failed (${reason}) for clipping: ${clipping.path}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Watch Later Synthesizer] Extraction request failed for clipping: ${clipping.path}`,
				error
			);
			return null;
		}
	}

	private buildUserPrompt(clipping: Clipping, body: string): string {
		const lines = [`Title: ${clipping.title}`];
		if (clipping.url) {
			lines.push(`URL: ${clipping.url}`);
		}
		if (clipping.author) {
			lines.push(`Author: ${clipping.author}`);
		}
		if (clipping.savedDate) {
			lines.push(`Saved: ${clipping.savedDate}`);
		}
		lines.push("", "Article content:", body);
		return lines.join("\n");
	}

	// --- Theme synthesis internals ---

	/**
	 * Ask the LLM to synthesize one theme from its members' summaries and key
	 * claims. Same defensive path as extraction: safe parse with first-{ to
	 * last-} recovery, one retry, valid-but-empty detection, and warn-and-skip
	 * (returning null) on a second failure or a thrown request — so one bad
	 * theme never aborts the sync.
	 */
	private async synthesizeTheme(
		topic: string,
		members: Clipping[]
	): Promise<ThemeSynthesis | null> {
		const userPrompt = this.buildThemePrompt(topic, members);

		try {
			const first = await this.llm.complete(THEME_SYSTEM_PROMPT, userPrompt);
			const firstOutcome = this.parseTheme(first);
			if (firstOutcome.kind === "ok") {
				return firstOutcome.value;
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but contained no consensus. " +
						"Return the JSON object with a non-empty consensus."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(THEME_SYSTEM_PROMPT, retryPrompt);
			const secondOutcome = this.parseTheme(second);
			if (secondOutcome.kind === "ok") {
				return secondOutcome.value;
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but empty synthesis"
					: "invalid JSON";
			console.warn(
				`[Watch Later Synthesizer] Theme synthesis failed (${reason}) for theme: ${topic}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Watch Later Synthesizer] Theme synthesis request failed for theme: ${topic}`,
				error
			);
			return null;
		}
	}

	private buildThemePrompt(topic: string, members: Clipping[]): string {
		const lines = [`Theme: ${topic}`, "", "Sources:"];
		for (const member of members) {
			const extraction = this.cache.extractions[member.path]?.extraction;
			if (!extraction) {
				continue;
			}
			lines.push("", `Title: ${member.title}`);
			lines.push(`Summary: ${this.oneLine(extraction.summary)}`);
			if (extraction.keyClaims.length > 0) {
				lines.push(`Key claims: ${extraction.keyClaims.join(" ")}`);
			}
		}
		return lines.join("\n");
	}

	private parseTheme(raw: string): ParseOutcome<ThemeSynthesis> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		const synthesis = this.coerceTheme(value);
		if (synthesis === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", value: synthesis };
	}

	/** Validate/normalize an arbitrary parsed value into a ThemeSynthesis. */
	private coerceTheme(value: unknown): ThemeSynthesis | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const consensus =
			typeof obj["consensus"] === "string" ? obj["consensus"].trim() : "";
		if (consensus === "") {
			return null;
		}

		const synthesis: ThemeSynthesis = {
			consensus,
			tension:
				typeof obj["tension"] === "string" ? obj["tension"].trim() : "",
		};

		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			synthesis.language = languageMatch[0];
		}

		return synthesis;
	}

	/** Assemble the cached extraction from a validated LLM result. */
	private toClipExtraction(
		clipping: Clipping,
		body: string,
		raw: RawExtraction
	): ClipExtraction {
		const extraction: ClipExtraction = {
			id: this.hash(clipping.path),
			summary: raw.summary,
			keyClaims: raw.keyClaims,
			topics: raw.topics,
			readTimeMinutes: this.estimateReadTime(body),
		};
		if (raw.language !== undefined) {
			extraction.language = raw.language;
		}
		return extraction;
	}

	/** ~200 words per minute, never less than 1 minute. Deterministic. */
	private estimateReadTime(body: string): number {
		const words = body.split(/\s+/).filter((w) => w !== "").length;
		return Math.max(1, Math.round(words / 200));
	}

	private parseExtraction(raw: string): ParseOutcome<RawExtraction> {
		const value = this.extractJsonValue(raw);
		if (value === undefined) {
			return { kind: "invalid-json" };
		}
		const extraction = this.coerceExtraction(value);
		if (extraction === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", value: extraction };
	}

	/**
	 * Best-effort JSON recovery from a raw model response, shared by extraction
	 * and theme synthesis. Strips code fences, parses as-is, and if that fails
	 * retries on the substring from the first "{" to the last "}" (weak models
	 * often wrap JSON in prose like "Here is the JSON: {…}"). Returns undefined
	 * when nothing parses — a safe sentinel, since JSON.parse never yields it.
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
			text = text
				.replace(/^```[a-zA-Z]*\s*/, "")
				.replace(/\s*```$/, "");
		}
		return text.trim();
	}

	/** Validate/normalize an arbitrary parsed value into a RawExtraction. */
	private coerceExtraction(value: unknown): RawExtraction | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const summary =
			typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
		if (summary === "") {
			return null;
		}

		const extraction: RawExtraction = {
			summary,
			keyClaims: this.toStringArray(obj["keyClaims"]),
			topics: this.toStringArray(obj["topics"]).map((t) => t.toLowerCase()),
		};

		// Accept "en" but also sloppy variants like "en-US"; keep the 639-1 part.
		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			extraction.language = languageMatch[0];
		}

		return extraction;
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
