import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	WatchLaterSettingTab,
	type WatchLaterSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { ClippingCollector } from "./collector";
import { SynthesisEngine, type ClippingInput } from "./synthesizer";
import { verifyLicense } from "./license";
import type { Clipping, SynthesisCache } from "./types";

function emptyCache(): SynthesisCache {
	return { extractions: {}, themeSyntheses: {}, lastSynced: "" };
}

/**
 * Shape of the single JSON blob Obsidian persists for this plugin. Settings and
 * the synthesis cache live side by side so saving one never clobbers the other.
 */
interface PersistedData {
	settings: WatchLaterSettings;
	cache: SynthesisCache;
}

export default class WatchLaterSynthesizerPlugin extends Plugin {
	settings: WatchLaterSettings = DEFAULT_SETTINGS;
	cache: SynthesisCache = emptyCache();

	llm!: LLMAdapter;
	collector!: ClippingCollector;
	engine!: SynthesisEngine;

	override async onload(): Promise<void> {
		console.log("Watch Later Synthesizer loaded.");

		await this.loadSettings();

		this.llm = new LLMAdapter(this.settings);
		this.collector = new ClippingCollector(this.app, this.settings);
		this.engine = new SynthesisEngine(this.llm, this.cache);

		this.addSettingTab(new WatchLaterSettingTab(this.app, this));

		this.addCommand({
			id: "sync-clippings",
			name: "Sync clippings",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "generate-report",
			name: "Generate report",
			callback: () => {
				void this.runGenerateReport();
			},
		});

		this.addRibbonIcon("book-open", "Generate report", () => {
			void this.runGenerateReport();
		});
	}

	override onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PersistedData> | null;

		// Tolerate a legacy flat-settings layout (a build that saved the settings
		// object at the top level) so an existing API key survives.
		const settingsSource =
			data && "settings" in data
				? data.settings
				: (data as Partial<WatchLaterSettings> | null);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource ?? {});

		this.cache =
			(data && "cache" in data ? data.cache : null) ?? emptyCache();
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	/** Persist settings and cache together as one blob. */
	private async persist(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			cache: this.cache,
		};
		await this.saveData(data);
	}

	/**
	 * Sync the reading inbox: collect clippings, prepare bodies for the
	 * new/changed ones, hand them to the pure engine, persist the cache.
	 * All vault I/O happens here — the engine never touches files.
	 */
	private async runSync(): Promise<void> {
		// Pro gate. Lifetime free tier: 3 successful syncs, no monthly reset.
		// Pro users are never counted or blocked. Bail before any LLM call.
		const isPro = verifyLicense(this.settings.proLicenseKey).valid;
		if (!isPro && this.settings.freeUsage.count >= 3) {
			new Notice(
				"Free limit reached: 3 total syncs. Upgrade to Pro for unlimited."
			);
			return;
		}

		try {
			const clippings = this.collector.collect();

			const inputs: ClippingInput[] = [];
			for (const clipping of clippings) {
				if (!this.engine.needsExtraction(clipping)) {
					continue;
				}
				const body = await this.readBody(clipping);
				if (body === null) {
					continue;
				}
				inputs.push({ clipping, body });
			}

			const result = await this.engine.syncClippings(
				clippings,
				inputs,
				this.todayISO()
			);
			await this.persist();

			// Count the use only after a fully successful sync. One sync = one
			// use, regardless of how many clippings it touched.
			if (!isPro) {
				this.settings.freeUsage.count += 1;
				await this.persist();
			}

			new Notice(
				`Synced ${result.extracted} clippings, ${result.themes} themes ` +
					`(${result.themesResynthesized} re-synthesized, ` +
					`${result.skipped} skipped, ${result.failed} failed).`
			);
		} catch (error) {
			console.error("Watch Later Synthesizer: sync failed", error);
			new Notice("Sync failed. See console for details.");
		}
	}

	/**
	 * Render the report from the current cache and write it to a fixed vault
	 * note, overwriting if it exists, then open it. Zero LLM calls — always
	 * free; collecting clippings only reads vault metadata.
	 */
	private async runGenerateReport(): Promise<void> {
		const path = "Reading Synthesis.md";
		try {
			const clippings = this.collector.collect();
			const markdown = this.engine.buildReportMarkdown(
				clippings,
				this.todayISO(),
				this.settings.staleDays
			);

			const existing = this.app.vault.getAbstractFileByPath(path);
			let file: TFile;
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, markdown);
				file = existing;
			} else {
				file = await this.app.vault.create(path, markdown);
			}

			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice("Reading report updated.");
		} catch (error) {
			console.error(
				"Watch Later Synthesizer: failed to write reading report",
				error
			);
			new Notice("Failed to write reading report. See console.");
		}
	}

	/**
	 * Read a clipping's article body: frontmatter stripped, markdown noise
	 * cleaned, then truncated to MAX_INPUT_CHARS so long articles fit
	 * small-context models. Returns null when the path no longer resolves to
	 * a file (vanished mid-sync).
	 */
	private async readBody(clipping: Clipping): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(clipping.path);
		if (!(file instanceof TFile)) {
			return null;
		}
		const raw = await this.app.vault.cachedRead(file);
		const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		return this.cleanBody(stripped).slice(0, MAX_INPUT_CHARS);
	}

	/**
	 * Strip markdown noise so the truncation window lands on real prose, not
	 * navigation boilerplate: link-heavy pages otherwise fill the first 24k
	 * chars with URLs and the model sees no article text at all.
	 */
	private cleanBody(text: string): string {
		// Image embeds carry no prose — drop them entirely.
		let cleaned = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
		// Markdown links: keep the visible text, drop the URL.
		cleaned = cleaned.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
		// Bare URLs are pure token waste.
		cleaned = cleaned.replace(/https?:\/\/\S+/g, "");

		// Blank out lines left with no letters or digits (list markers,
		// brackets, punctuation), then collapse the resulting gaps so
		// paragraph structure survives but boilerplate runs don't.
		cleaned = cleaned
			.split("\n")
			.map((line) => (/[\p{L}\p{N}]/u.test(line) ? line : ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");

		return cleaned.trim();
	}

	/**
	 * Today as a calendar-date string (YYYY-MM-DD) in LOCAL time — never
	 * toISOString(), which would shift the date across the UTC boundary in
	 * non-UTC timezones. The engine never reads the clock; this is where
	 * "today" enters the system.
	 */
	private todayISO(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
}
