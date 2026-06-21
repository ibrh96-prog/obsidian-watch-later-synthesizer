import { App, PluginSettingTab, Setting } from "obsidian";
import type WatchLaterSynthesizerPlugin from "./main";
import { verifyLicense } from "./license";

export type LLMProvider = "anthropic" | "openai-compatible";

/** Floor for the stale-clipping threshold; flagging anything younger than a
 * week would just be noise. Mirrored defensively in the report engine. */
export const STALE_DAYS_MIN = 7;

export interface WatchLaterSettings {
	provider: LLMProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	clippingsFolder: string;
	clippingsTag: string;
	staleDays: number;
	proLicenseKey: string;
	// Lifetime free-tier usage. A "use" is one successful sync; there is no
	// monthly reset, so the count only ever grows until a Pro license unlocks it.
	freeUsage: { count: number };
}

export const DEFAULT_SETTINGS: WatchLaterSettings = {
	provider: "anthropic",
	apiKey: "",
	baseUrl: "https://api.anthropic.com",
	model: "claude-sonnet-4-6",
	clippingsFolder: "Clippings",
	clippingsTag: "clipping",
	staleDays: 90,
	proLicenseKey: "",
	freeUsage: { count: 0 },
};

export class WatchLaterSettingTab extends PluginSettingTab {
	private readonly plugin: WatchLaterSynthesizerPlugin;

	constructor(app: App, plugin: WatchLaterSynthesizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Language model section ---
		new Setting(containerEl).setName("Language model").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Which API shape to use for synthesis requests.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("anthropic", "Anthropic")
					.addOption("openai-compatible", "OpenAI-compatible")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as LLMProvider;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Stored locally in this vault. Never committed or shared.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("API endpoint root, without a trailing slash.")
			.addText((text) => {
				text
					.setPlaceholder("https://api.anthropic.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model identifier passed to the provider.")
			.addText((text) => {
				text
					.setPlaceholder("claude-sonnet-4-6")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- Clipping detection section ---
		new Setting(containerEl).setName("Clipping detection").setHeading();

		new Setting(containerEl)
			.setName("Clippings folder")
			.setDesc("Vault-relative folder whose notes are treated as clippings.")
			.addText((text) => {
				text
					.setPlaceholder("Clippings")
					.setValue(this.plugin.settings.clippingsFolder)
					.onChange(async (value) => {
						this.plugin.settings.clippingsFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Clippings tag")
			.setDesc("Any note carrying this tag also counts as a clipping.")
			.addText((text) => {
				text
					.setPlaceholder("clipping")
					.setValue(this.plugin.settings.clippingsTag)
					.onChange(async (value) => {
						this.plugin.settings.clippingsTag = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Stale after (days)")
			.setDesc(
				`Clippings saved this many days ago are flagged "Needs attention" in the report. Minimum ${STALE_DAYS_MIN}.`
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder("90")
					.setValue(String(this.plugin.settings.staleDays))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.staleDays = Number.isFinite(parsed)
							? Math.max(STALE_DAYS_MIN, parsed)
							: DEFAULT_SETTINGS.staleDays;
						await this.plugin.saveSettings();
					});
			});

		// --- License section ---
		new Setting(containerEl).setName("License").setHeading();

		new Setting(containerEl)
			.setName("Pro license key")
			.setDesc("Unlocks Pro features. Leave empty to run the free tier.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("RIS-...")
					.setValue(this.plugin.settings.proLicenseKey)
					.onChange(async (value) => {
						this.plugin.settings.proLicenseKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const status = verifyLicense(this.plugin.settings.proLicenseKey);
		if (status.valid) {
			new Setting(containerEl)
				.setName("✓ Pro active")
				.setDesc(`Licensed to ${status.email}`);
		} else if (this.plugin.settings.proLicenseKey) {
			new Setting(containerEl)
				.setName("License invalid")
				.setDesc(status.reason ?? "Could not verify license key.");
		} else {
			new Setting(containerEl).setDesc(
				`Free tier — 3 total syncs (${this.plugin.settings.freeUsage.count}/3 used)`
			);
		}
	}
}
