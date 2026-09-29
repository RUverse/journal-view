import { App, PluginSettingTab, Setting, requireApiVersion } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem, ToggleComponent } from "obsidian";
import type { VaultDailyConfig } from "./dailyNotes";
import type JournalViewPlugin from "./main";

export const MIN_SAVE_DELAY = 200;
export const MAX_SAVE_DELAY = 3000;
const SAVE_DELAY_STEP = 100;
export const MIN_LOADED_DAYS = 20;
export const MAX_LOADED_DAYS = 120;
const LOADED_DAYS_STEP = 5;
export const MONTH_SEPARATOR_DAY_FORMAT = "dddd, D";
export const LEGACY_FULL_HEADER_FORMAT = "dddd, D MMMM YYYY";

export type DaySortDirection = "ascending" | "descending";
export type DailyHeaderStyle = "subtle" | "h1" | "hidden";
export type JournalFilterMode = "include" | "exclude";
export type JournalFilterValue = string | number | boolean;

export type JournalFilterRule =
	| { kind: "tag"; mode: JournalFilterMode; tag: string }
	| {
			kind: "property";
			mode: JournalFilterMode;
			property: string;
			value: JournalFilterValue;
	  };

export interface JournalViewSettings {
	/** Overrides the daily-note date format. Empty = inherit from the vault. */
	dateFormat: string;
	/** Overrides the daily-note folder. Empty = inherit from the vault. */
	folder: string;
	/** Overrides the daily-note template. Empty = inherit from the vault. */
	templatePath: string;
	/** How the date is written in each day's header. */
	headerFormat: string;
	/** How prominently each day's date is displayed. */
	headerStyle: DailyHeaderStyle;
	/** Show month/year once above a group rather than inside every day. */
	showMonthSeparators: boolean;
	/** Group rendered days beneath year boundary headings. */
	groupDaysByYear: boolean;
	/** Milliseconds of inactivity before an edited day is written to disk. */
	saveDelay: number;
	/** Target maximum number of day sections kept in the timeline. */
	maxLoadedDays: number;
	/** Use Obsidian's own markdown editor inside the journal (live preview). */
	richEditor: boolean;
	/** Put the cursor in today's note when the view opens. */
	focusTodayOnOpen: boolean;
	/** Open or reveal the journal after Obsidian restores the workspace. */
	openJournalOnStartup: boolean;
	/** Show only days that have a note (today always shows). */
	hideEmptyDays: boolean;
	/** Tag and property rules that decide which existing notes are visible. */
	filterRules: JournalFilterRule[];
	/** Show frontmatter tags above each existing note's body. */
	showTags: boolean;
	/** Frontmatter property names shown above each existing note's body. */
	displayProperties: string[];
	/** Chronological direction in which days are laid out. */
	daySortDirection: DaySortDirection;
}

export const DEFAULT_SETTINGS: JournalViewSettings = {
	dateFormat: "",
	folder: "",
	templatePath: "",
	headerFormat: "dddd, D MMMM",
	headerStyle: "subtle",
	showMonthSeparators: false,
	groupDaysByYear: true,
	// Obsidian debounces its own `TextFileView.requestSave` by the same amount,
	// so an edited day reaches disk as often as the note would in a normal pane.
	saveDelay: 2000,
	maxLoadedDays: 60,
	richEditor: true,
	focusTodayOnOpen: true,
	openJournalOnStartup: false,
	hideEmptyDays: true,
	filterRules: [],
	showTags: false,
	displayProperties: [],
	daySortDirection: "ascending",
};

type SettingKey = keyof JournalViewSettings;
type TextSettingKey = "headerFormat";
type InheritedSettingKey = "dateFormat" | "folder" | "templatePath";
type ToggleSettingKey =
	| "richEditor"
	| "focusTodayOnOpen"
	| "openJournalOnStartup"
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
	/** Works the text out as the row is drawn, so it never shows a stale value. */
	describe?: () => string;
}

interface JournalTextSetting extends JournalSettingBase {
	control: { type: "text"; key: TextSettingKey; placeholder: string };
}

/** A field that follows the vault's daily-note settings while it is left empty. */
interface JournalInheritedSetting extends JournalSettingBase {
	control: {
		type: "inherited";
		key: InheritedSettingKey;
		/** The vault's value the field follows while empty. */
		inherited: (vault: VaultDailyConfig) => string;
		/** Placeholder when the vault has no value either. */
		emptyLabel: string;
	};
}

interface JournalToggleSetting extends JournalSettingBase {
	control: { type: "toggle"; key: ToggleSettingKey };
}

interface JournalSliderSetting extends JournalSettingBase {
	control: {
		type: "slider";
		key: "saveDelay" | "maxLoadedDays";
		min: number;
		max: number;
		step: number;
	};
}

type JournalDropdownControl =
	| {
			type: "dropdown";
			key: "daySortDirection";
			options: Record<DaySortDirection, string>;
	  }
	| {
			type: "dropdown";
			key: "headerStyle";
			options: Record<DailyHeaderStyle, string>;
	  };

interface JournalDropdownSetting extends JournalSettingBase {
	control: JournalDropdownControl;
}

type JournalSetting =
	| JournalInfoSetting
	| JournalTextSetting
	| JournalInheritedSetting
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
	private hideEmptyToggle: ToggleComponent | null = null;

	constructor(app: App, private plugin: JournalViewPlugin) {
		super(app, plugin);
	}

	/**
	 * Declarative settings used in Obsidian 1.13+. Obsidian keeps these for as
	 * long as the plugin is loaded, so rows showing the vault's daily-note
	 * settings draw themselves, working those values out each time.
	 */
	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return this.definitions().map((group) => ({
			...group,
			items: group.items.map((item) => this.toDefinition(item)),
		}));
	}

	private toDefinition(item: JournalSetting): SettingDefinition<SettingKey> {
		const { name, desc } = item;
		if (isInheritedSetting(item)) {
			const control = item.control;
			return { name, desc, render: (setting) => this.renderInherited(setting.setName(name).setDesc(desc), control) };
		}
		const describe = !item.control ? item.describe : undefined;
		if (describe) {
			return {
				name,
				desc,
				searchable: item.searchable,
				render: (setting) => void setting.setName(name).setDesc(describe()),
			};
		}
		return item;
	}

	private definitions(): JournalSettingGroup[] {
		return [
			{
				type: "group",
				heading: "Daily notes",
				items: [
					{
						name: "Current configuration",
						desc: "Leave the fields below empty to follow your vault's daily-note settings.",
						describe: () => this.describeConfiguration(),
						searchable: false,
					},
					{
						name: "Date format",
						desc:
							"Moment.js format used for the file name of each day. End it with * to also show " +
							"notes named with more after the date, such as 2026-08-16 Birthday. Include a time, " +
							"such as YYYY-MM-DD HHmm, to keep several notes a day.",
						control: {
							type: "inherited",
							key: "dateFormat",
							inherited: (vault) => vault.format,
							emptyLabel: "YYYY-MM-DD",
						},
					},
					{
						name: "Folder",
						desc: "Folder that holds the daily notes.",
						control: {
							type: "inherited",
							key: "folder",
							inherited: (vault) => vault.folder,
							emptyLabel: "vault root",
						},
					},
					{
						name: "Template",
						desc: "Applied to every note this view creates, including when you write in an empty day.",
						control: {
							type: "inherited",
							key: "templatePath",
							inherited: (vault) => vault.template,
							emptyLabel: "none",
						},
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
						name: "Daily header style",
						desc: "Choose how prominently each day's date appears.",
						control: {
							type: "dropdown",
							key: "headerStyle",
							options: { subtle: "Subtle", h1: "H1", hidden: "Hidden" },
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
				heading: "Startup",
				items: [
					{
						name: "Open journal on startup",
						desc: "Open or reveal Journal View after Obsidian restores the workspace.",
						control: { type: "toggle", key: "openJournalOnStartup" },
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
					{
						name: "Days kept loaded",
						desc:
							"Target maximum number of days kept in the timeline. Lower values use less memory " +
							"but reload days sooner. Focused and nearby days may temporarily exceed the target.",
						control: {
							type: "slider",
							key: "maxLoadedDays",
							min: MIN_LOADED_DAYS,
							max: MAX_LOADED_DAYS,
							step: LOADED_DAYS_STEP,
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
			case "maxLoadedDays":
				if (typeof value === "number" && Number.isFinite(value)) {
					this.plugin.settings[key] = clampLoadedDays(value);
					changed = true;
				}
				break;
			case "daySortDirection":
				if (value === "ascending" || value === "descending") {
					this.plugin.settings[key] = value;
					changed = true;
				}
				break;
			case "headerStyle":
				if (value === "subtle" || value === "h1" || value === "hidden") {
					this.plugin.settings[key] = value;
					changed = true;
				}
				break;
			case "richEditor":
			case "focusTodayOnOpen":
			case "openJournalOnStartup":
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
		this.hideEmptyToggle = null;
		containerEl.empty();
		for (const group of this.definitions()) {
			new Setting(containerEl).setName(group.heading).setHeading();
			for (const definition of group.items) this.renderSetting(definition);
		}
	}

	private describeConfiguration(): string {
		const resolved = this.plugin.daily.config();
		return (
			`Leave the fields below empty to follow your vault's daily-note settings. ` +
			`Currently resolving to: format "${this.plugin.daily.displayFormat(resolved)}", ` +
			`folder "${resolved.folder || "/"}"` +
			(resolved.template ? `, template "${resolved.template}".` : ".")
		);
	}

	/**
	 * A field that follows the vault's daily-note settings while it is empty.
	 * Its placeholder shows the value it follows. Clicking into the empty field
	 * fills that value in, ready to adjust; leaving it unchanged empties it
	 * again, so it goes on following the vault rather than copying it.
	 */
	private renderInherited(setting: Setting, control: JournalInheritedSetting["control"]): void {
		const inherited = control.inherited(this.plugin.daily.inherited());
		setting.addText((text) => {
			const input = text.inputEl;
			let offered: string | null = null;
			text
				.setPlaceholder(inherited || control.emptyLabel)
				.setValue(this.plugin.settings[control.key])
				.onChange((value) => this.setControlValue(control.key, value));
			input.addEventListener("focus", () => {
				if (input.value || !inherited) return;
				offered = inherited;
				input.value = inherited;
				input.setSelectionRange(inherited.length, inherited.length);
			});
			input.addEventListener("blur", () => {
				const unchanged = offered !== null && input.value.trim() === offered;
				offered = null;
				if (!unchanged) return;
				input.value = "";
				// Edits that came back round to the vault's value would otherwise
				// leave it saved as an override that no longer follows the vault.
				if (this.plugin.settings[control.key]) void this.setControlValue(control.key, "");
			});
		});
	}

	private renderSetting(definition: JournalSetting): void {
		if (!definition.control) {
			this.containerEl.createEl("p", {
				cls: "setting-item-description journal-settings-note",
				text: definition.describe?.() ?? definition.desc,
			});
			return;
		}

		const setting = new Setting(this.containerEl).setName(definition.name).setDesc(definition.desc);
		const control = definition.control;
		switch (control.type) {
			case "inherited":
				this.renderInherited(setting, control);
				break;
			case "text":
				setting.addText((text) =>
					text
						.setPlaceholder(control.placeholder)
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value)),
				);
				break;
			case "toggle":
				setting.addToggle((toggle) => {
					if (control.key === "hideEmptyDays") this.hideEmptyToggle = toggle;
					toggle
						.setValue(this.plugin.settings[control.key])
						.onChange((value) => this.setControlValue(control.key, value));
				});
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

	syncFilterControls(): void {
		this.hideEmptyToggle?.setValue(this.plugin.settings.hideEmptyDays);
	}
}

function isInheritedSetting(item: JournalSetting): item is JournalInheritedSetting {
	return item.control?.type === "inherited";
}

function isSettingKey(key: string): key is keyof JournalViewSettings {
	return key in DEFAULT_SETTINGS;
}

export function clampSaveDelay(value: number): number {
	return Math.max(MIN_SAVE_DELAY, Math.min(MAX_SAVE_DELAY, value));
}

export function clampLoadedDays(value: number): number {
	const clamped = Math.max(MIN_LOADED_DAYS, Math.min(MAX_LOADED_DAYS, value));
	return Math.round(clamped / LOADED_DAYS_STEP) * LOADED_DAYS_STEP;
}

function showLegacySliderTooltip(slider: unknown): void {
	(slider as LegacySliderTooltip).setDynamicTooltip();
}
