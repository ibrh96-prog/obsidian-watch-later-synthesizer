import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	WatchLaterSettingTab,
	type WatchLaterSettings,
} from "./settings";
import { LLMAdapter } from "./llm";
import { VideoCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import { verifyLicense } from "./license";
import type { SynthesisCache, VideoRecord } from "./types";

const REPORT_PATH = "Watch Later Triage.md";

function emptyCache(): SynthesisCache {
	return {
		verdicts: {},
		themes: { memberSignature: "", recurringThemes: [], safeToDelete: [] },
		lastSynced: "",
	};
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
	collector!: VideoCollector;
	engine!: SynthesisEngine;

	override async onload(): Promise<void> {
		console.log("Watch Later Synthesizer loaded.");

		await this.loadSettings();

		this.llm = new LLMAdapter(this.settings);
		this.collector = new VideoCollector(this.app, this.settings);
		this.engine = new SynthesisEngine(this.llm, this.cache);

		this.addSettingTab(new WatchLaterSettingTab(this.app, this));

		this.addCommand({
			id: "sync-videos",
			name: "Sync videos",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "generate-triage-report",
			name: "Generate triage report",
			callback: () => {
				void this.runGenerateReport();
			},
		});

		this.addRibbonIcon("list-video", "Generate triage report", () => {
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
	 * Sync the watch-later pile: collect videos, hand them to the pure engine for
	 * triage, persist the cache. All vault and network I/O is owned here (the
	 * collector reads notes + oEmbed; the engine reaches the LLM only through the
	 * injected adapter) — the engine never touches files or settings.
	 */
	private async runSync(): Promise<void> {
		// Pro gate. Lifetime free tier: 3 successful runs, no monthly reset.
		// Pro users are never counted or blocked. Bail before any LLM call.
		const isPro = verifyLicense(this.settings.proLicenseKey).valid;
		if (!isPro && this.settings.freeUsage.count >= 3) {
			new Notice(
				"Free limit reached: 3 total runs. Upgrade to Pro for unlimited."
			);
			return;
		}

		try {
			const videos = await this.collector.collect();
			const { result, stats } = await this.engine.triage(videos);

			this.cache.lastSynced = this.todayISO();
			await this.persist();

			// Count the use only after a fully successful run. One run = one use,
			// regardless of how many videos it touched.
			if (!isPro) {
				this.settings.freeUsage.count += 1;
				await this.persist();
			}

			const watch = result.verdicts.filter(
				(v) => v.verdict === "watch"
			).length;
			const skip = result.verdicts.filter((v) => v.verdict === "skip").length;
			new Notice(
				`Triaged ${stats.total} videos: ${watch} watch, ${skip} skip ` +
					`(${stats.computed} new, ${stats.reused} cached, ${stats.failed} failed).`
			);
		} catch (error) {
			console.error("Watch Later Synthesizer: triage failed", error);
			new Notice("Triage failed. See console for details.");
		}
	}

	/**
	 * Render the triage report from the current cache and write it to a fixed
	 * vault note, overwriting if it exists, then open it. Zero LLM calls — always
	 * free; collecting videos reads note metadata and may call oEmbed only.
	 */
	private async runGenerateReport(): Promise<void> {
		try {
			const videos = await this.collector.collect();
			const markdown = this.buildReportMarkdown(videos);

			const existing = this.app.vault.getAbstractFileByPath(REPORT_PATH);
			let file: TFile;
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, markdown);
				file = existing;
			} else {
				file = await this.app.vault.create(REPORT_PATH, markdown);
			}

			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice("Triage report updated.");
		} catch (error) {
			console.error(
				"Watch Later Synthesizer: failed to write triage report",
				error
			);
			new Notice("Failed to write triage report. See console.");
		}
	}

	/**
	 * Format the triage report markdown from the collected videos and the cached
	 * verdicts/themes. Pure string assembly — all formatting lives here, not in
	 * the engine. Videos with no cached verdict are listed under "Not triaged
	 * yet" so the report never silently drops them.
	 */
	private buildReportMarkdown(videos: VideoRecord[]): string {
		const lines: string[] = [];
		const byId = new Map(videos.map((v) => [v.videoId, v]));
		const verdictOf = (videoId: string) =>
			this.cache.verdicts[videoId]?.verdict;

		lines.push("# Watch Later Triage");
		lines.push("");
		lines.push(`_Last synced: ${this.cache.lastSynced || "never"}_`);
		lines.push("");

		const watch = videos.filter(
			(v) => verdictOf(v.videoId)?.verdict === "watch"
		);
		const skip = videos.filter((v) => verdictOf(v.videoId)?.verdict === "skip");
		const untriaged = videos.filter((v) => verdictOf(v.videoId) === undefined);

		// --- Watch ---
		lines.push(`## Watch (${watch.length})`);
		if (watch.length === 0) {
			lines.push("_Nothing to watch._");
		} else {
			for (const video of watch) {
				lines.push(this.videoLine(video));
			}
		}
		lines.push("");

		// --- Skip ---
		lines.push(`## Skip (${skip.length})`);
		if (skip.length === 0) {
			lines.push("_Nothing to skip._");
		} else {
			for (const video of skip) {
				lines.push(this.videoLine(video));
			}
		}
		lines.push("");

		// --- Recurring themes ---
		lines.push("## Recurring themes");
		const themes = this.cache.themes.recurringThemes;
		if (themes.length === 0) {
			lines.push("_No themes recur across the pile yet._");
		} else {
			for (const theme of themes) {
				lines.push(`- ${theme}`);
			}
		}
		lines.push("");

		// --- Safe to delete ---
		lines.push("## Safe to delete");
		const safe = this.cache.themes.safeToDelete;
		if (safe.length === 0) {
			lines.push("_Nothing flagged safe to delete._");
		} else {
			for (const id of safe) {
				const video = byId.get(id);
				lines.push(
					video ? `- [${this.titleOf(video)}](${video.url})` : `- ${id}`
				);
			}
		}
		lines.push("");

		// --- Not triaged yet ---
		if (untriaged.length > 0) {
			lines.push(`## Not triaged yet (${untriaged.length})`);
			lines.push('_Run "Sync videos" to triage these._');
			for (const video of untriaged) {
				lines.push(`- [${this.titleOf(video)}](${video.url})`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/** One report bullet for a video: title link, channel, topic, and reason. */
	private videoLine(video: VideoRecord): string {
		const verdict = this.cache.verdicts[video.videoId]?.verdict;
		const channel = video.channel ? ` — ${video.channel}` : "";
		const topic = verdict?.likelyTopic ? ` — _${verdict.likelyTopic}_` : "";
		const reason = verdict?.reason ? ` — ${verdict.reason}` : "";
		return `- [${this.titleOf(video)}](${video.url})${channel}${topic}${reason}`;
	}

	/** A video's display title, falling back to its id when unknown. */
	private titleOf(video: VideoRecord): string {
		return video.title ?? video.videoId;
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
