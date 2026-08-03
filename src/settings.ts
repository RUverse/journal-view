import { App, PluginSettingTab, Setting } from "obsidian";
import type JournalViewPlugin from "./main";

export interface JournalViewSettings {
	/** Overrides the daily-note date format. Empty = inherit from the vault. */
	dateFormat: string;
	/** Overrides the daily-note folder. Empty = inherit from the vault. */
	folder: string;
	/** Overrides the daily-note template. Empty = inherit from the vault. */
	templatePath: string;
	/** How the date is written in each day's header. */
	headerFormat: string;
	/** Milliseconds of inactivity before an edited day is written to disk. */
	saveDelay: number;
	/** Use Obsidian's own markdown editor inside the journal (live preview). */
	richEditor: boolean;
	/** Put the cursor in today's note when the view opens. */
	focusTodayOnOpen: boolean;
	/** Show only days that have a note (today always shows). */
	hideEmptyDays: boolean;
}

export const DEFAULT_SETTINGS: JournalViewSettings = {
	dateFormat: "",
	folder: "",
	templatePath: "",
	headerFormat: "dddd, D MMMM YYYY",
	saveDelay: 600,
	richEditor: true,
	focusTodayOnOpen: true,
	hideEmptyDays: true,
};

export class JournalViewSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: JournalViewPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const resolved = this.plugin.daily.config();

		new Setting(containerEl).setName("Daily notes").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description journal-settings-note",
			text:
				`Leave the fields below empty to follow your vault's daily-note settings. ` +
				`Currently resolving to: format "${resolved.format}", folder "${resolved.folder || "/"}"` +
				(resolved.template ? `, template "${resolved.template}".` : "."),
		});

		new Setting(containerEl)
			.setName("Date format")
			.setDesc("Moment.js format used for the file name of each day.")
			.addText((text) =>
				text
					.setPlaceholder(resolved.format)
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Folder that holds the daily notes.")
			.addText((text) =>
				text
					.setPlaceholder(resolved.folder || "vault root")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Template")
			.setDesc('Applied when a note is created with the "Create note" button in a day header.')
			.addText((text) =>
				text
					.setPlaceholder(resolved.template || "none")
					.setValue(this.plugin.settings.templatePath)
					.onChange(async (value) => {
						this.plugin.settings.templatePath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Journal view").setHeading();

		new Setting(containerEl)
			.setName("Header date format")
			.setDesc("Moment.js format for the date shown above each day.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.headerFormat)
					.setValue(this.plugin.settings.headerFormat)
					.onChange(async (value) => {
						this.plugin.settings.headerFormat = value.trim() || DEFAULT_SETTINGS.headerFormat;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Focus today on open")
			.setDesc("Place the cursor in today's note as soon as the journal opens.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.focusTodayOnOpen).onChange(async (value) => {
					this.plugin.settings.focusTodayOnOpen = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Only show days that have a note")
			.setDesc(
				"Days with no file are skipped entirely, so the journal jumps from one note to the next. " +
					"Today is always shown. When off, every day appears, faded until you type in it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideEmptyDays).onChange(async (value) => {
					this.plugin.settings.hideEmptyDays = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Rich editor")
			.setDesc(
				"Use Obsidian's own markdown editor (live preview, links, formatting) for each day. " +
					"Turn off to fall back to a plain text editor.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.richEditor).onChange(async (value) => {
					this.plugin.settings.richEditor = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Performance").setHeading();

		new Setting(containerEl)
			.setName("Autosave delay")
			.setDesc("Milliseconds of inactivity before an edited day is written to disk.")
			.addSlider((slider) =>
				slider
					.setLimits(200, 3000, 100)
					.setValue(this.plugin.settings.saveDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.saveDelay = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
