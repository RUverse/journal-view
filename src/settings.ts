import { App, PluginSettingTab, Setting, requireApiVersion } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type JournalViewPlugin from "./main";

export const MIN_SAVE_DELAY = 200;
export const MAX_SAVE_DELAY = 3000;
const SAVE_DELAY_STEP = 100;
export const MONTH_SEPARATOR_DAY_FORMAT = "dddd, D";
export const LEGACY_FULL_HEADER_FORMAT = "dddd, D MMMM YYYY";

export type DaySortDirection = "ascending" | "descending";

export interface JournalViewSettings {
	/** Overrides the daily-note date format. Empty = inherit from the vault. */
	dateFormat: string;
	/** Overrides the daily-note folder. Empty = inherit from the vault. */
	folder: string;
	/** Overrides the daily-note template. Empty = inherit from the vault. */
	templatePath: string;
	/** How the date is written in each day's header. */
	headerFormat: string;
	/** Show month/year once above a group rather than inside every day. */
	showMonthSeparators: boolean;
	/** Group rendered days beneath year boundary headings. */
	groupDaysByYear: boolean;
	/** Milliseconds of inactivity before an edited day is written to disk. */
	saveDelay: number;
	/** Use Obsidian's own markdown editor inside the journal (live preview). */
	richEditor: boolean;
	/** Put the cursor in today's note when the view opens. */
	focusTodayOnOpen: boolean;
	/** Show only days that have a note (today always shows). */
	hideEmptyDays: boolean;
	/** Chronological direction in which days are laid out. */
	daySortDirection: DaySortDirection;
}

export const DEFAULT_SETTINGS: JournalViewSettings = {
	dateFormat: "",
	folder: "",
	templatePath: "",
	headerFormat: "dddd, D MMMM",
	showMonthSeparators: false,
	groupDaysByYear: true,
	// Obsidian debounces its own `TextFileView.requestSave` by the same amount,
	// so an edited day reaches disk as often as the note would in a normal pane.
	saveDelay: 2000,
	richEditor: true,
	focusTodayOnOpen: true,
	hideEmptyDays: true,
	daySortDirection: "ascending",
};

type SettingKey = keyof JournalViewSettings;
type TextSettingKey = "dateFormat" | "folder" | "templatePath" | "headerFormat";
type ToggleSettingKey =
	| "richEditor"
	| "focusTodayOnOpen"
	| "hideEmptyDays"
	| "showMonthSeparators"
	| "groupDaysByYear";

interface JournalSettingBase {
	name: string;
	desc: string;
	searchable?: boolean;
}

interface JournalInfoSetting extends JournalSettingBase {
	control?: never;
}

interface JournalTextSetting extends JournalSettingBase {
	control: { type: "text"; key: TextSettingKey; placeholder: string };
}

interface JournalToggleSetting extends JournalSettingBase {
	control: { type: "toggle"; key: ToggleSettingKey };
}

interface JournalSliderSetting extends JournalSettingBase {
	control: { type: "slider"; key: "saveDelay"; min: number; max: number; step: number };
}

interface JournalDropdownSetting extends JournalSettingBase {
	control: {
		type: "dropdown";
		key: "daySortDirection";
		options: Record<DaySortDirection, string>;
	};
}

type JournalSetting =
	| JournalInfoSetting
	| JournalTextSetting
	| JournalToggleSetting
	| JournalSliderSetting
	| JournalDropdownSetting;

interface JournalSettingGroup {
	type: "group";
	heading: string;
	items: JournalSetting[];
}

interface LegacySliderTooltip {
	setDynamicTooltip(): void;
}

export class JournalViewSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: JournalViewPlugin) {
		super(app, plugin);
	}

	/** Declarative settings used for settings search in Obsidian 1.13+. */
	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return this.definitions();
	}

	private definitions(): JournalSettingGroup[] {
		const resolved = this.plugin.daily.config();
		return [
			{
				type: "group",
				heading: "Daily notes",
				items: [
					{
						name: "Current configuration",
						desc:
							`Leave the fields below empty to follow your vault's daily-note settings. ` +
							`Currently resolving to: format "${resolved.format}", folder "${resolved.folder || "/"}"` +
							(resolved.template ? `, template "${resolved.template}".` : "."),
						searchable: false,
					},
					{
						name: "Date format",
						desc: "Moment.js format used for the file name of each day.",
						control: { type: "text", key: "dateFormat", placeholder: resolved.format },
					},
					{
						name: "Folder",
						desc: "Folder that holds the daily notes.",
						control: { type: "text", key: "folder", placeholder: resolved.folder || "vault root" },
					},
					{
						name: "Template",
						desc: "Applied to every note this view creates, including when you write in an empty day.",
						control: { type: "text", key: "templatePath", placeholder: resolved.template || "none" },
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{
						name: "Day order",
						desc: "Choose which dates appear first in the journal.",
						control: {
							type: "dropdown",
							key: "daySortDirection",
							options: { ascending: "Oldest to newest", descending: "Newest to oldest" },
						},
					},
					{
						name: "Daily header format",
						desc: "Moment.js format used for each day's header.",
						control: {
							type: "text",
							key: "headerFormat",
							placeholder: DEFAULT_SETTINGS.headerFormat,
						},
					},
					{
						name: "Group days by year",
						desc: "Show a centered year heading when consecutive visible days cross a year boundary.",
						control: { type: "toggle", key: "groupDaysByYear" },
					},
					{
						name: "Group days by month",
						desc: "Show month and year once above the first visible day of each month.",
						control: { type: "toggle", key: "showMonthSeparators" },
					},
					{
						name: "Focus today on open",
						desc: "Automatically place the insertion point in today's note when the journal opens.",
						control: { type: "toggle", key: "focusTodayOnOpen" },
					},
					{
						name: "Only show days that have a note",
						desc:
							"Days with no file are skipped entirely, so the journal jumps from one note to the next. " +
							"Today is always shown. When off, every day appears, faded until you type in it.",
						control: { type: "toggle", key: "hideEmptyDays" },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Rich editor",
						desc:
							"Use Obsidian's own markdown editor (live preview, links, formatting) for each day. " +
							"Turn off to fall back to a plain text editor.",
						control: { type: "toggle", key: "richEditor" },
					},
					{
						name: "Autosave delay",
						desc:
							"Milliseconds of inactivity before an edited day is written to disk. " +
							"Leaving a day always saves it at once.",
						control: {
							type: "slider",
							key: "saveDelay",
							min: MIN_SAVE_DELAY,
							max: MAX_SAVE_DELAY,
							step: SAVE_DELAY_STEP,
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return isSettingKey(key) ? this.plugin.settings[key] : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isSettingKey(key)) return;
		let changed = false;
		switch (key) {
			case "dateFormat":
			case "folder":
			case "templatePath":
				if (typeof value === "string") {
					this.plugin.settings[key] = value.trim();
					changed = true;
				}
				break;
			case "headerFormat":
				if (typeof value === "string") {
					this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS.headerFormat;
					changed = true;
				}
				break;
			case "saveDelay":
				if (typeof value === "number" && Number.isFinite(value)) {
					this.plugin.settings[key] = clampSaveDelay(value);
					changed = true;
				}
				break;
			case "daySortDirection":
				if (value === "ascending" || value === "descending") {
					this.plugin.settings[key] = value;
					changed = true;
				}
				break;
			case "richEditor":
			case "focusTodayOnOpen":
			case "hideEmptyDays":
			case "showMonthSeparators":
			case "groupDaysByYear":
				if (typeof value === "boolean") {
					this.plugin.settings[key] = value;
					changed = true;
				}
				break;
		}
		if (changed) await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const group of this.definitions()) {
			new Setting(containerEl).setName(group.heading).setHeading();
			for (const definition of group.items) this.renderSetting(definition);
		}
	}

	private renderSetting(definition: JournalSetting): void {
		if (!definition.control) {
			this.containerEl.createEl("p", {
				cls: "setting-item-description journal-settings-note",
				text: definition.desc,
			});
			return;
		}

		const setting = new Setting(this.containerEl).setName(definition.name).setDesc(definition.desc);
		const control = definition.control;
		switch (control.type) {
			case "text":
				setting.addText((text) =>
					text
						.setPlaceholder(control.placeholder)
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value)),
				);
				break;
			case "toggle":
				setting.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value)),
				);
				break;
			case "slider":
				setting.addSlider((slider) => {
					slider
						.setLimits(control.min, control.max, control.step)
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value));
					if (!requireApiVersion("1.13.0")) showLegacySliderTooltip(slider);
				});
				break;
			case "dropdown":
				setting.addDropdown((dropdown) =>
					dropdown
						.addOptions(control.options)
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value)),
				);
				break;
		}
	}
}

function isSettingKey(key: string): key is keyof JournalViewSettings {
	return key in DEFAULT_SETTINGS;
}

export function clampSaveDelay(value: number): number {
	return Math.max(MIN_SAVE_DELAY, Math.min(MAX_SAVE_DELAY, value));
}

function showLegacySliderTooltip(slider: unknown): void {
	(slider as LegacySliderTooltip).setDynamicTooltip();
}
