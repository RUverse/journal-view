import { AbstractInputSuggest, App, Modal, Notice, Setting, setIcon } from "obsidian";
import type JournalViewPlugin from "./main";

interface AppearanceModalOptions {
	onDismiss?(): void;
}

/** Autocomplete attached to the property-name field. */
class PropertySuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private readonly items: () => string[],
		private readonly onValueSelected: (value: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const needle = query.trim().toLocaleLowerCase();
		return this.items().filter((item) => !needle || item.toLocaleLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		this.close();
		this.onValueSelected(value);
	}
}

/** Global, immediately persisted controls for the metadata shown on each day. */
export class AppearanceModal extends Modal {
	private propertyInput!: HTMLInputElement;
	private addButton!: HTMLButtonElement;
	private propertyList!: HTMLElement;
	private suggest: PropertySuggest | null = null;
	private knownProperties: string[] = [];
	private saving: Promise<void> = Promise.resolve();

	constructor(
		app: App,
		private plugin: JournalViewPlugin,
		private options: AppearanceModalOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("journal-appearance-modal");
		this.titleEl.setText("Customization");
		this.knownProperties = this.discoverProperties();

		const tagsSetting = new Setting(this.contentEl)
			.setName("Display tags")
			.setDesc("Show tags from each daily note's frontmatter above its body.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showTags).onChange((value) => {
					this.plugin.settings.showTags = value;
					this.persist();
				}),
			);
		tagsSetting.nameEl.addClass("journal-appearance-setting-name");
		const tagsIcon = tagsSetting.nameEl.createSpan({ cls: "journal-appearance-setting-icon" });
		setIcon(tagsIcon, "tags");
		tagsIcon.setAttribute("aria-hidden", "true");
		tagsSetting.nameEl.prepend(tagsIcon);

		const propertiesSetting = new Setting(this.contentEl)
			.setName("Properties")
			.setDesc("Choose frontmatter properties to show on every existing daily note.")
			.setClass("journal-appearance-properties-heading");
		propertiesSetting.nameEl.addClass("journal-appearance-setting-name");
		const propertiesIcon = propertiesSetting.nameEl.createSpan({
			cls: "journal-appearance-setting-icon",
		});
		setIcon(propertiesIcon, "list-tree");
		propertiesIcon.setAttribute("aria-hidden", "true");
		propertiesSetting.nameEl.prepend(propertiesIcon);

		const add = new Setting(this.contentEl).setName("Add property");
		add.settingEl.addClass("journal-appearance-add-property");
		add.addText((text) => {
			text.setPlaceholder("Property name").onChange((value) => this.syncAddButton(value));
			this.propertyInput = text.inputEl;
			this.propertyInput.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || event.isComposing) return;
				event.preventDefault();
				this.addProperty(this.propertyInput.value);
			});
		});
		add.addButton((button) => {
			button.setButtonText("Add").setCta().setDisabled(true);
			this.addButton = button.buttonEl;
			this.addButton.type = "button";
			// Commit before clicking the button blurs the autocomplete input. Its
			// popover can otherwise consume the gesture while it closes.
			this.addButton.addEventListener("pointerdown", (event) => {
				if (event.button !== 0 || this.addButton.disabled) return;
				event.preventDefault();
				this.addProperty(this.propertyInput.value);
			});
			// Keyboard and assistive clicks do not have a pointer event.
			this.addButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.detail === 0) this.addProperty(this.propertyInput.value);
			});
		});
		this.suggest = new PropertySuggest(
			this.app,
			this.propertyInput,
			() => this.availableProperties(),
			(value) => {
				this.syncAddButton(value);
				this.propertyInput.focus();
			},
		);

		this.propertyList = this.contentEl.createDiv({ cls: "journal-appearance-properties" });
		this.renderPropertyList();
	}

	onClose(): void {
		this.suggest?.close();
		this.suggest = null;
		this.contentEl.empty();
		this.options.onDismiss?.();
	}

	private discoverProperties(): string[] {
		this.plugin.index.ensureCurrent();
		const properties = new Map<string, string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.plugin.index.keyForPath(file.path) === null) continue;
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) continue;
			for (const rawName of Object.keys(frontmatter)) {
				const name = rawName.trim();
				const key = name.toLocaleLowerCase();
				if (!name || key === "tags" || key === "position" || properties.has(key)) continue;
				properties.set(key, name);
			}
		}
		return Array.from(properties.values()).sort((left, right) => left.localeCompare(right));
	}

	private availableProperties(): string[] {
		const selected = new Set(this.plugin.settings.displayProperties.map((name) => name.toLocaleLowerCase()));
		return this.knownProperties.filter((name) => !selected.has(name.toLocaleLowerCase()));
	}

	private syncAddButton(value: string): void {
		this.addButton.disabled = value.trim().length === 0;
	}

	private addProperty(rawName: string): void {
		const name = rawName.trim();
		if (!name) return;
		const key = name.toLocaleLowerCase();
		if (key === "tags") {
			new Notice('Use the "display tags" toggle to show tags.');
			return;
		}
		if (this.plugin.settings.displayProperties.some((current) => current.toLocaleLowerCase() === key)) {
			new Notice(`Property "${name}" is already displayed.`);
			return;
		}

		this.plugin.settings.displayProperties = [...this.plugin.settings.displayProperties, name];
		this.propertyInput.value = "";
		this.syncAddButton("");
		this.renderPropertyList();
		this.persist();
	}

	private removeProperty(index: number): void {
		this.plugin.settings.displayProperties = this.plugin.settings.displayProperties.filter(
			(_name, current) => current !== index,
		);
		this.renderPropertyList();
		this.persist();
	}

	private renderPropertyList(): void {
		this.propertyList.empty();
		const properties = this.plugin.settings.displayProperties;
		if (!properties.length) {
			this.propertyList.createDiv({
				cls: "setting-item-description journal-appearance-empty",
				text: "No properties selected.",
			});
			return;
		}

		properties.forEach((name, index) => {
			new Setting(this.propertyList).setName(name).addExtraButton((button) =>
				button
					.setIcon("x")
					.setTooltip(`Stop displaying ${name}`)
					.onClick(() => this.removeProperty(index)),
			);
		});
	}

	private persist(): void {
		this.plugin.notifyViewsImmediately();
		this.saving = this.saving
			.then(() => this.plugin.saveSettings(false))
			.catch((error: unknown) => {
				console.error("Journal View: could not save appearance settings", error);
				new Notice("Journal view: could not save appearance settings");
			});
	}
}
