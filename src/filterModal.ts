import { AbstractInputSuggest, App, Modal, Notice, Setting, getAllTags } from "obsidian";
import type { CachedMetadata, ToggleComponent } from "obsidian";
import {
	normalizeFilterTag,
	sameFilterRule,
	sameFilterValue,
} from "./filter";
import type JournalViewPlugin from "./main";
import type {
	JournalFilterMode,
	JournalFilterRule,
	JournalFilterValue,
} from "./settings";

interface FilterModalOptions {
	onDismiss?(): void;
}

interface ValueOption {
	label: string;
	input: string;
	value: JournalFilterValue;
}

class TextSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private readonly items: () => string[],
		private readonly display: (value: string) => string = (value) => value,
		private readonly selected?: (value: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const needle = query.trim().replace(/^#/, "").toLocaleLowerCase();
		return this.items().filter((item) => !needle || item.toLocaleLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(this.display(value));
	}

	selectSuggestion(value: string): void {
		this.setValue(this.display(value));
		this.close();
		this.selected?.(value);
	}
}

class ValueSuggest extends AbstractInputSuggest<ValueOption> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private readonly items: () => ValueOption[],
		private readonly selected: (option: ValueOption) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): ValueOption[] {
		const needle = query.trim().toLocaleLowerCase();
		return this.items().filter((item) => !needle || item.label.toLocaleLowerCase().includes(needle));
	}

	renderSuggestion(option: ValueOption, el: HTMLElement): void {
		el.setText(option.label);
	}

	selectSuggestion(option: ValueOption): void {
		this.setValue(option.input);
		this.close();
		this.selected(option);
	}
}

const NUMBER_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function parseValueInput(raw: string): { valid: boolean; value?: JournalFilterValue } {
	const value = raw.trim();
	if (!value) return { valid: false };
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return { valid: true, value: parsed };
		} catch {
			return { valid: false };
		}
	}
	if (value === "true" || value === "false") return { valid: true, value: value === "true" };
	if (NUMBER_VALUE.test(value)) {
		const number = Number(value);
		if (Number.isFinite(number)) return { valid: true, value: number };
	}
	return { valid: true, value };
}

function valueInput(value: JournalFilterValue): string {
	if (typeof value !== "string") return String(value);
	return value === "true" || value === "false" || NUMBER_VALUE.test(value) || !value.trim()
		? JSON.stringify(value)
		: value;
}

function valueLabel(value: JournalFilterValue): string {
	const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
	return `${shown} · ${typeof value}`;
}

function ruleLabel(rule: JournalFilterRule): string {
	const mode = rule.mode === "include" ? "Include" : "Exclude";
	if (rule.kind === "tag") return `${mode} tag #${rule.tag}`;
	const value = typeof rule.value === "string" ? JSON.stringify(rule.value) : String(rule.value);
	return `${mode} ${rule.property} = ${value}`;
}

/** Persistent global controls for which dates belong in the journal. */
export class FilterModal extends Modal {
	private mode: JournalFilterMode = "include";
	private kind: JournalFilterRule["kind"] = "tag";
	private tagInput!: HTMLInputElement;
	private propertyInput!: HTMLInputElement;
	private valueInput!: HTMLInputElement;
	private addButton!: HTMLButtonElement;
	private addSettingEl!: HTMLElement;
	private listEl!: HTMLElement;
	private hideEmptyToggle!: ToggleComponent;
	private stopControlSync: (() => void) | null = null;
	private tagSuggest: TextSuggest | null = null;
	private propertySuggest: TextSuggest | null = null;
	private valueSuggest: ValueSuggest | null = null;
	private tags: string[] = [];
	private properties = new Map<string, string>();
	private propertyValues = new Map<string, JournalFilterValue[]>();
	private selectedValue: ValueOption | null = null;
	private saving: Promise<void> = Promise.resolve();

	constructor(
		app: App,
		private plugin: JournalViewPlugin,
		private options: FilterModalOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("journal-filter-modal");
		this.titleEl.setText("Filter notes");
		this.discoverMetadata();

		new Setting(this.contentEl)
			.setName("Show only days with notes")
			.setDesc("Hide empty dates. Today is always shown.")
			.addToggle((toggle) =>
				(this.hideEmptyToggle = toggle).setValue(this.plugin.settings.hideEmptyDays).onChange((value) => {
					this.plugin.settings.hideEmptyDays = value;
					this.persist();
				}),
			);
		this.stopControlSync = this.plugin.onFilterControlsChanged(() => {
			this.hideEmptyToggle.setValue(this.plugin.settings.hideEmptyDays);
		});

		new Setting(this.contentEl)
			.setName("Tag and property filters")
			.setDesc("All include filters must match. Any matching exclude filter hides the note.")
			.setClass("journal-filter-metadata-heading");

		const add = new Setting(this.contentEl).setName("Add filter").setClass("journal-filter-add");
		this.addSettingEl = add.settingEl;
		add.addDropdown((dropdown) => {
			dropdown.addOption("include", "Include").addOption("exclude", "Exclude").setValue(this.mode);
			dropdown.selectEl.setAttribute("aria-label", "Filter mode");
			dropdown.onChange((value) => {
				this.mode = value === "exclude" ? "exclude" : "include";
			});
		});
		add.addDropdown((dropdown) => {
			dropdown.addOption("tag", "Tag").addOption("property", "Property").setValue(this.kind);
			dropdown.selectEl.setAttribute("aria-label", "Filter type");
			dropdown.onChange((value) => {
				this.kind = value === "property" ? "property" : "tag";
				this.syncEditor();
			});
		});
		add.addText((text) => {
			text.setPlaceholder("Tag").onChange(() => this.syncAddButton());
			this.tagInput = text.inputEl;
			this.tagInput.setAttribute("aria-label", "Tag");
			this.tagInput.addEventListener("keydown", (event) => this.onInputKeydown(event));
		});
		add.addText((text) => {
			text.setPlaceholder("Property").onChange(() => {
				this.selectedValue = null;
				this.syncAddButton();
			});
			this.propertyInput = text.inputEl;
			this.propertyInput.setAttribute("aria-label", "Property name");
			this.propertyInput.addEventListener("keydown", (event) => this.onInputKeydown(event));
		});
		add.addText((text) => {
			text.setPlaceholder("Value").onChange(() => {
				if (this.selectedValue?.input !== this.valueInput.value) this.selectedValue = null;
				this.syncAddButton();
			});
			this.valueInput = text.inputEl;
			this.valueInput.setAttribute("aria-label", "Property value");
			this.valueInput.addEventListener("keydown", (event) => this.onInputKeydown(event));
		});
		add.addButton((button) => {
			button.setButtonText("Add").setCta().setDisabled(true);
			this.addButton = button.buttonEl;
			this.addButton.type = "button";
			// Commit before the pointer blurs an open autocomplete popover, which
			// can otherwise consume the gesture while it dismisses itself.
			this.addButton.addEventListener("pointerdown", (event) => {
				if (event.button !== 0 || this.addButton.disabled) return;
				event.preventDefault();
				this.addRule();
			});
			// Keyboard and assistive clicks do not have a pointer event.
			this.addButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail === 0 && !this.addButton.disabled) this.addRule();
			});
		});

		this.tagSuggest = new TextSuggest(
			this.app,
			this.tagInput,
			() => this.tags,
			(value) => `#${value}`,
			() => this.syncAddButton(),
		);
		this.propertySuggest = new TextSuggest(
			this.app,
			this.propertyInput,
			() => Array.from(this.properties.values()),
			undefined,
			() => {
				this.selectedValue = null;
				this.syncAddButton();
			},
		);
		this.valueSuggest = new ValueSuggest(
			this.app,
			this.valueInput,
			() => this.availableValues(),
			(option) => {
				this.selectedValue = option;
				this.syncAddButton();
			},
		);

		this.listEl = this.contentEl.createDiv({ cls: "journal-filter-rules" });
		this.renderRules();
		this.syncEditor();
	}

	onClose(): void {
		this.stopControlSync?.();
		this.stopControlSync = null;
		this.tagSuggest?.close();
		this.propertySuggest?.close();
		this.valueSuggest?.close();
		this.tagSuggest = this.propertySuggest = null;
		this.valueSuggest = null;
		this.contentEl.empty();
		this.options.onDismiss?.();
	}

	private discoverMetadata(): void {
		this.plugin.index.ensureCurrent();
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.plugin.index.keyForPath(file.path) === null) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			for (const rawTag of getAllTags(cache ?? {}) ?? []) {
				const tag = normalizeFilterTag(rawTag);
				if (tag) tags.add(tag);
			}
			this.discoverProperties(cache);
		}
		this.tags = Array.from(tags).sort((left, right) => left.localeCompare(right));
	}

	private discoverProperties(cache: CachedMetadata | null): void {
		if (!cache?.frontmatter) return;
		for (const [rawName, stored] of Object.entries(cache.frontmatter)) {
			const property = rawName.trim();
			const key = property.toLocaleLowerCase();
			if (!property || key === "tags" || key === "position") continue;
			if (!this.properties.has(key)) this.properties.set(key, property);
			const values = this.propertyValues.get(key) ?? [];
			const candidates = Array.isArray(stored) ? stored : [stored];
			for (const value of candidates) {
				if (
					(typeof value === "string" || typeof value === "boolean" ||
						(typeof value === "number" && Number.isFinite(value))) &&
					!values.some((current) => sameFilterValue(current, value))
				) {
					values.push(value);
				}
			}
			this.propertyValues.set(key, values);
		}
	}

	private availableValues(): ValueOption[] {
		const key = this.propertyInput.value.trim().toLocaleLowerCase();
		return (this.propertyValues.get(key) ?? [])
			.map((value) => ({ label: valueLabel(value), input: valueInput(value), value }))
			.sort((left, right) => left.label.localeCompare(right.label));
	}

	private syncEditor(): void {
		const tag = this.kind === "tag";
		this.addSettingEl.toggleClass("is-property", !tag);
		this.tagInput.toggleAttribute("hidden", !tag);
		this.propertyInput.toggleAttribute("hidden", tag);
		this.valueInput.toggleAttribute("hidden", tag);
		this.syncAddButton();
	}

	private syncAddButton(): void {
		if (!this.addButton) return;
		if (this.kind === "tag") {
			this.addButton.disabled = !normalizeFilterTag(this.tagInput.value);
			return;
		}
		const hasValue = this.selectedValue !== null || parseValueInput(this.valueInput.value).valid;
		this.addButton.disabled = !this.propertyInput.value.trim() || !hasValue;
	}

	private onInputKeydown(event: KeyboardEvent): void {
		if (event.key !== "Enter" || event.isComposing || this.addButton.disabled) return;
		event.preventDefault();
		this.addRule();
	}

	private addRule(): void {
		let rule: JournalFilterRule;
		if (this.kind === "tag") {
			const tag = normalizeFilterTag(this.tagInput.value);
			if (!tag) return;
			rule = { kind: "tag", mode: this.mode, tag };
		} else {
			const property = this.propertyInput.value.trim();
			if (["tags", "position"].includes(property.toLocaleLowerCase())) {
				new Notice(
					property.toLocaleLowerCase() === "tags"
						? "Use a tag filter for tags."
						: "That is an internal metadata field and cannot be filtered.",
				);
				return;
			}
			const parsed = this.selectedValue
				? { valid: true, value: this.selectedValue.value }
				: parseValueInput(this.valueInput.value);
			if (!property || !parsed.valid || parsed.value === undefined) return;
			rule = { kind: "property", mode: this.mode, property, value: parsed.value };
		}

		if (this.plugin.settings.filterRules.some((current) => sameFilterRule(current, rule))) {
			new Notice("That journal filter already exists.");
			return;
		}
		this.plugin.settings.filterRules = [...this.plugin.settings.filterRules, rule];
		this.tagInput.value = "";
		this.propertyInput.value = "";
		this.valueInput.value = "";
		this.selectedValue = null;
		this.renderRules();
		this.syncAddButton();
		this.persist();
	}

	private removeRule(index: number): void {
		this.plugin.settings.filterRules = this.plugin.settings.filterRules.filter(
			(_rule, current) => current !== index,
		);
		this.renderRules();
		this.persist();
	}

	private renderRules(): void {
		this.listEl.empty();
		const rules = this.plugin.settings.filterRules;
		if (!rules.length) {
			this.listEl.createDiv({
				cls: "setting-item-description journal-filter-empty",
				text: "No tag or property filters.",
			});
			return;
		}
		rules.forEach((rule, index) => {
			new Setting(this.listEl).setName(ruleLabel(rule)).addExtraButton((button) =>
				button.setIcon("x").setTooltip("Remove filter").onClick(() => this.removeRule(index)),
			);
		});
	}

	private persist(): void {
		this.plugin.notifyFiltersImmediately();
		this.saving = this.saving
			.then(() => this.plugin.saveSettings(false))
			.catch((error: unknown) => {
				console.error("Journal View: could not save filters", error);
				new Notice("Journal view: could not save filters");
			});
	}
}
