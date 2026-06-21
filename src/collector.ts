// IMPORTANT: transcripts are intentionally NOT fetched. YouTube PoToken
// bot-detection blocks client-side caption fetching via requestUrl, so v1 runs
// on note metadata + the public oEmbed endpoint only. Do not add any YouTube
// endpoint other than oEmbed, and never fetch the watch page HTML or captions.

import { App, TFile, getAllTags, requestUrl } from "obsidian";
import type { WatchLaterSettings } from "./settings";
import type { VideoRecord } from "./types";

/**
 * Gathers watch-later YouTube notes from the vault and returns VideoRecord[].
 * Pure I/O layer — no LLM calls, no synthesis. A note qualifies if it lives
 * under the configured Source folder OR carries the configured Source tag.
 *
 * Two note shapes are supported:
 *   - PRIMARY: an Obsidian Web Clipper YouTube note, one video per note, with
 *     per-video frontmatter (url/title/channel/published/duration).
 *   - FALLBACK: a running-list note with no per-video frontmatter — its body is
 *     scanned for bare YouTube URLs, one VideoRecord per unique URL.
 *
 * Missing title/channel are backfilled from YouTube's oEmbed endpoint.
 */
export class VideoCollector {
	private readonly app: App;
	private readonly settings: WatchLaterSettings;

	constructor(app: App, settings: WatchLaterSettings) {
		this.app = app;
		this.settings = settings;
	}

	async collect(): Promise<VideoRecord[]> {
		const records: VideoRecord[] = [];
		const seenIds = new Set<string>();

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isWatchLaterNote(file)) {
				continue;
			}

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const body = this.stripFrontmatter(await this.app.vault.cachedRead(file));

			const candidates: VideoRecord[] = [];
			if (this.strOrNull(frontmatter?.["url"]) !== null) {
				// PRIMARY: Web Clipper YouTube note (one video, frontmatter-driven).
				const record = this.parseClipperNote(file, frontmatter, body);
				if (record) {
					candidates.push(record);
				}
			} else {
				// FALLBACK: running-list note — scan the body for bare YouTube URLs.
				for (const { videoId, url } of this.scanBodyUrls(body)) {
					candidates.push({
						videoId,
						url,
						title: null,
						channel: null,
						published: null,
						duration: null,
						sourceFile: file.path,
						descriptionText: null,
					});
				}
			}

			// Deduplicate by videoId across the whole collection so the same video
			// listed in two notes produces a single record.
			for (const record of candidates) {
				if (seenIds.has(record.videoId)) {
					continue;
				}
				seenIds.add(record.videoId);
				records.push(record);
			}
		}

		await this.enrichMissing(records);
		return records;
	}

	// --- Note selection (unchanged folder-OR-tag mechanism) ---

	private isWatchLaterNote(file: TFile): boolean {
		return this.matchesFolder(file) || this.matchesTag(file);
	}

	private matchesFolder(file: TFile): boolean {
		const folder = this.settings.clippingsFolder.trim().replace(/\/+$/, "");
		if (folder === "") {
			return false;
		}
		return file.path === folder || file.path.startsWith(`${folder}/`);
	}

	private matchesTag(file: TFile): boolean {
		const wanted = this.normalizeTag(this.settings.clippingsTag);
		if (wanted === "") {
			return false;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			return false;
		}
		const tags = getAllTags(cache) ?? [];
		return tags.some((tag) => this.normalizeTag(tag) === wanted);
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, "").toLowerCase();
	}

	// --- Primary parse: Web Clipper YouTube note ---

	/**
	 * Build one VideoRecord from a clipper note's frontmatter plus its body
	 * `## Description`. Returns null (and warns) when no videoId can be parsed
	 * from the frontmatter url — warn-and-skip, never throw.
	 */
	private parseClipperNote(
		file: TFile,
		frontmatter: Record<string, unknown> | undefined,
		body: string
	): VideoRecord | null {
		const url = this.strOrNull(frontmatter?.["url"]);
		const videoId = url ? this.extractVideoId(url) : null;
		if (!url || !videoId) {
			console.warn(
				`[Watch Later Synthesizer] No parseable YouTube videoId in ${file.path}; skipping.`
			);
			return null;
		}

		return {
			videoId,
			url,
			title: this.strOrNull(frontmatter?.["title"]),
			channel: this.strOrNull(frontmatter?.["channel"]),
			published: this.strOrNull(frontmatter?.["published"]),
			duration: this.strOrNull(frontmatter?.["duration"]),
			sourceFile: file.path,
			descriptionText: this.extractDescription(body),
		};
	}

	/**
	 * Capture the text under a `## Description` heading until the next heading or
	 * end of note. Returns null when there is no Description section (or it is
	 * empty). Operates on a body that already has frontmatter stripped.
	 */
	private extractDescription(body: string): string | null {
		const lines = body.split("\n");

		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (/^#{1,6}\s+description\s*$/i.test(lines[i].trim())) {
				start = i + 1;
				break;
			}
		}
		if (start === -1) {
			return null;
		}

		const captured: string[] = [];
		for (let i = start; i < lines.length; i++) {
			if (/^#{1,6}\s+/.test(lines[i])) {
				break; // next heading ends the section
			}
			captured.push(lines[i]);
		}

		const text = captured.join("\n").trim();
		return text === "" ? null : text;
	}

	// --- Fallback parse: running-list note ---

	/**
	 * Find unique YouTube URLs in a note body (frontmatter already stripped).
	 * Each result carries the parsed videoId and the exact URL as written.
	 * Deduped by videoId within the note; the caller dedupes again globally.
	 */
	private scanBodyUrls(body: string): Array<{ videoId: string; url: string }> {
		const found: Array<{ videoId: string; url: string }> = [];
		const seen = new Set<string>();

		const urlPattern =
			/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?\S*|youtu\.be\/[A-Za-z0-9_-]{11}\S*)/gi;
		let match: RegExpExecArray | null;
		while ((match = urlPattern.exec(body)) !== null) {
			// Trim trailing markdown/sentence punctuation the greedy \S* may grab.
			const url = match[0].replace(/[).,;]+$/, "");
			const videoId = this.extractVideoId(url);
			if (!videoId || seen.has(videoId)) {
				continue;
			}
			seen.add(videoId);
			found.push({ videoId, url });
		}

		return found;
	}

	// --- oEmbed enrichment (missing title/channel only) ---

	/**
	 * Backfill title and channel from YouTube's public oEmbed endpoint, but only
	 * for records missing either field — a record with both already (from
	 * frontmatter) makes no network call. Fully defensive: any failure leaves
	 * the fields null and moves on; one bad call never aborts the collection.
	 */
	private async enrichMissing(records: VideoRecord[]): Promise<void> {
		for (const record of records) {
			if (record.title !== null && record.channel !== null) {
				continue;
			}

			try {
				const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(
					record.url
				)}&format=json`;
				const response = await requestUrl({
					url: endpoint,
					method: "GET",
					throw: false,
				});

				if (response.status < 200 || response.status >= 300) {
					console.warn(
						`[Watch Later Synthesizer] oEmbed failed (${response.status}) for ${record.url}`
					);
					continue;
				}

				const data = response.json as {
					title?: unknown;
					author_name?: unknown;
				};
				const title = this.strOrNull(data.title);
				const channel = this.strOrNull(data.author_name);
				if (record.title === null && title !== null) {
					record.title = title;
				}
				if (record.channel === null && channel !== null) {
					record.channel = channel;
				}
			} catch (error) {
				console.warn(
					`[Watch Later Synthesizer] oEmbed request failed for ${record.url}`,
					error
				);
			}
		}
	}

	// --- Helpers ---

	/**
	 * Parse a YouTube videoId from a URL. Handles the two canonical forms
	 * `youtube.com/watch?v=ID` and `youtu.be/ID`. Returns null when neither
	 * matches an 11-character id.
	 */
	private extractVideoId(url: string): string | null {
		const watch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
		if (watch) {
			return watch[1];
		}
		const short = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
		if (short) {
			return short[1];
		}
		return null;
	}

	/** Remove a leading YAML frontmatter block so body parsing sees prose only. */
	private stripFrontmatter(raw: string): string {
		return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	}

	/** Non-empty trimmed string, or null for anything else. */
	private strOrNull(value: unknown): string | null {
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed === "" ? null : trimmed;
	}
}
