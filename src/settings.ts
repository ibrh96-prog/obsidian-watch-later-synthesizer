import { App, PluginSettingTab, Setting } from "obsidian";
import type WatchLaterSynthesizerPlugin from "./main";
import { verifyLicense, GUMROAD_URL } from "./license";

export type LLMProvider = "anthropic" | "openai-compatible";

export interface WatchLaterSettings {
	provider: LLMProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	// These two keys are the watch-later video source (folder OR tag). The
	// clippings* identifiers are retained as internal setting keys; renaming
	// them is deferred to avoid breaking saved user settings on disk.
	clippingsFolder: string;
	clippingsTag: string;
	proLicenseKey: string;
	// Lifetime free-tier usage. A "use" is one successful run; there is no
	// monthly reset, so the count only ever grows until a Pro license unlocks it.
	freeUsage: { count: number };
}

export const DEFAULT_SETTINGS: WatchLaterSettings = {
	provider: "anthropic",
	apiKey: "",
	baseUrl: "https://api.anthropic.com",
	model: "claude-sonnet-4-6",
	clippingsFolder: "Watch Later",
	clippingsTag: "watch-later",
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

		// --- Source section ---
		new Setting(containerEl).setName("Source").setHeading();

		new Setting(containerEl)
			.setName("Videos folder")
			.setDesc(
				"Vault-relative folder whose notes are treated as watch-later videos."
			)
			.addText((text) => {
				text
					.setPlaceholder("Watch Later")
					.setValue(this.plugin.settings.clippingsFolder)
					.onChange(async (value) => {
						this.plugin.settings.clippingsFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Videos tag")
			.setDesc("Any note carrying this tag also counts as a watch-later video.")
			.addText((text) => {
				text
					.setPlaceholder("watch-later")
					.setValue(this.plugin.settings.clippingsTag)
					.onChange(async (value) => {
						this.plugin.settings.clippingsTag = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// --- AI synthesis section ---
		new Setting(containerEl).setName("AI synthesis").setHeading();

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

		// --- License section ---
		new Setting(containerEl).setName("License").setHeading();

		new Setting(containerEl)
			.setName("Pro license key")
			.setDesc("Unlocks Pro features. Leave empty to run the free tier.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("WLS-...")
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
				`Free tier — 3 total syncs (lifetime). (${this.plugin.settings.freeUsage.count}/3 used)`
			);
		}

		if (!status.valid) {
			new Setting(containerEl).setName("Upgrade to Pro").setHeading();

			new Setting(containerEl)
				.setName("Unlimited syncs")
				.setDesc(
					"Pro unlocks unlimited syncs. One-time payment — no subscription."
				)
				.addButton((btn) => {
					btn.setButtonText("Get Pro license").setCta().onClick(() => {
						window.open(GUMROAD_URL, "_blank");
					});
				});
		}
	}
}
