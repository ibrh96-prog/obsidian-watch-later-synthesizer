import { App, TFile, getAllTags } from "obsidian";
import type { WatchLaterSettings } from "./settings";
import type { Clipping } from "./types";

/**
 * Gathers web clippings from the vault. Pure collection — no LLM calls.
 * A note qualifies if it lives under the configured folder OR carries the
 * configured tag.
 */
export class ClippingCollector {
	private readonly app: App;
	private readonly settings: WatchLaterSettings;

	constructor(app: App, settings: WatchLaterSettings) {
		this.app = app;
		this.settings = settings;
	}

	collect(): Clipping[] {
		const clippings: Clipping[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isClipping(file)) {
				continue;
			}
			clippings.push(this.toClipping(file));
		}

		return clippings;
	}

	private isClipping(file: TFile): boolean {
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

	/**
	 * Map a vault file to a Clipping. Clipper templates vary wildly, so every
	 * frontmatter field is optional and read defensively: the URL may live under
	 * "source" or "url", the saved date under "created" or "date saved".
	 */
	private toClipping(file: TFile): Clipping {
		const frontmatter =
			this.app.metadataCache.getFileCache(file)?.frontmatter;

		const clipping: Clipping = {
			path: file.path,
			title: file.basename,
			mtime: file.stat.mtime,
		};

		const url =
			this.asString(frontmatter?.["source"]) ??
			this.asString(frontmatter?.["url"]);
		if (url !== undefined) {
			clipping.url = url;
		}

		const author = this.asString(frontmatter?.["author"]);
		if (author !== undefined) {
			clipping.author = author;
		}

		const savedDate =
			this.parseDate(frontmatter?.["created"]) ??
			this.parseDate(frontmatter?.["published"]) ??
			this.parseDate(frontmatter?.["date saved"]);
		if (savedDate !== undefined) {
			clipping.savedDate = savedDate;
		}

		const status = this.asString(frontmatter?.["status"]);
		if (status !== undefined) {
			clipping.status = status;
		}

		return clipping;
	}

	/**
	 * Normalize a frontmatter date to a YYYY-MM-DD string. Clipper templates
	 * vary: accept ISO ("2026-06-13" or a full timestamp, sliced to the date)
	 * and European "DD.MM.YYYY" ("13.06.2026"). Pure string parsing — never
	 * `new Date()` — so locale and timezone can't shift the result. Anything
	 * unrecognized stays undefined rather than guessing.
	 */
	private parseDate(value: unknown): string | undefined {
		const raw = this.asString(value);
		if (raw === undefined) {
			return undefined;
		}

		const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
		if (iso) {
			return iso[1];
		}

		const european = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
		if (european) {
			return `${european[3]}-${european[2]}-${european[1]}`;
		}

		return undefined;
	}

	/** Non-empty trimmed string, or undefined for anything else. */
	private asString(value: unknown): string | undefined {
		if (typeof value !== "string") {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	}
}
