import { Modal, Notice, Setting, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { DAY_KEY_FORMAT } from "../noteIndex";
import {
	DEFAULT_REFLECTION_SERVER,
	MAX_REFLECTION_CONTEXT,
	MIN_REFLECTION_CONTEXT,
	REFLECTION_CONTEXT_STEP,
	clampReflectionContext,
	reflectionFolderSetting,
	reflectionServerSetting,
	showSliderTooltip,
} from "../settings";
import { summarizeScope } from "./context";
import {
	canRestoreBuiltIns,
	presetRequest,
	presetsOf,
	questionRequest,
	restoreBuiltIns,
	scopeLabel,
} from "./presets";
import type { ReflectionPreset, ReflectionRequest, ReflectionScope } from "./presets";
import { NO_MODELS_MESSAGE, ProviderError, describeProviderError } from "./provider";
import type { ModelInfo } from "./provider";

export interface ReflectionModalOptions {
	/** Called once a reflection has started, after the window closes. */
	onStart?: () => void;
	onClose?: () => void;
}

/** Where the window is: asking, its settings, or one preset being edited. */
type Page =
	| { kind: "ask" }
	| { kind: "settings" }
	| { kind: "preset"; preset: ReflectionPreset; isNew: boolean; back: "ask" | "settings" };

/** What the model server said when it was last asked. */
type Connection =
	| { state: "checking" }
	| { state: "ready"; models: ModelInfo[] }
	| { state: "unreachable"; message: string }
	| { state: "no-models" }
	| { state: "failed"; message: string };

/** A question's choice of notes, as the scope picker names it. */
type ScopeChoice = "model" | "days:7" | "days:14" | "days:30" | "days:90" | "this-day" | "range";

const SCOPE_CHOICES: Record<ScopeChoice, string> = {
	model: "Let the model choose",
	"days:7": "Last 7 days",
	"days:14": "Last 14 days",
	"days:30": "Last 30 days",
	"days:90": "Last 90 days",
	"this-day": "This day over the years",
	range: "Dates…",
};

/** The setup steps' names and commands, written as they are. */
const SETUP = {
	install: "Install Ollama from ",
	pull: "ollama pull ",
	pullSmall: "ollama pull gemma4:e4b",
	pullLarge: "ollama pull gemma4:26b",
};

/** What a model without tools reads for a question, and a preset saved from a range. */
const DEFAULT_CHOICE: ScopeChoice = "days:14";

/**
 * The question being written, kept while the plugin runs, so closing the
 * window by accident does not lose it. Cleared once it is asked.
 */
const draft: { question: string; choice: ScopeChoice | null; from: string | null; to: string | null } = {
	question: "",
	choice: null,
	from: null,
	to: null,
};

/**
 * The Reflect window, opened from today's button and the Create reflection
 * command. It asks a question of the reader's own over notes they choose,
 * or runs a preset at a click; its settings page holds the connection, the
 * model, the folder and the presets, which the plugin's settings tab leaves
 * to it.
 */
export class ReflectionModal extends Modal {
	private page: Page = { kind: "ask" };
	/** The scope chosen on the ask page. */
	private choice: ScopeChoice = DEFAULT_CHOICE;
	private connection: Connection = { state: "checking" };
	/** Bumped by every check, so an older answer arriving late is dropped. */
	private checkSerial = 0;
	private sizeSerial = 0;
	private readonly today: Moment = createMoment().startOf("day");
	private saving: Promise<void> = Promise.resolve();
	private closed = false;
	/** Redraws what on the current page depends on the connection. */
	private onConnection: (() => void) | null = null;
	/** The model reflections use, beside the settings button on the first page. */
	private modelBadge: HTMLElement | null = null;

	constructor(
		app: App,
		private plugin: JournalViewPlugin,
		private options: ReflectionModalOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("journal-reflect-modal");
		this.render();
		void this.check();
	}

	onClose(): void {
		this.closed = true;
		this.onConnection = null;
		this.contentEl.empty();
		this.options.onClose?.();
	}

	/* ------------------------------------------------------------- framing */

	private go(page: Page): void {
		this.page = page;
		this.render();
	}

	private render(): void {
		this.onConnection = null;
		this.modelBadge = null;
		this.contentEl.empty();
		this.titleEl.empty();
		this.modalEl.dataset.page = this.page.kind;
		switch (this.page.kind) {
			case "ask":
				this.renderTitle("Reflect", null);
				this.renderAsk();
				this.syncModelBadge();
				break;
			case "settings":
				this.renderTitle("Reflection settings", "ask");
				this.renderSettings();
				break;
			case "preset":
				this.renderTitle(this.page.isNew ? "New preset" : "Edit preset", this.page.back);
				this.renderPreset(this.page);
				break;
		}
	}

	/** The title, with a way back on the inner pages and to the settings on the first. */
	private renderTitle(text: string, back: "ask" | "settings" | null): void {
		const title = this.titleEl.createDiv({ cls: "journal-reflect-title" });
		if (back) {
			this.iconButton(title, "arrow-left", "Back", () => this.go({ kind: back }));
		}
		title.createSpan({ cls: "journal-reflect-title-text", text });
		if (!back) {
			this.modelBadge = title.createEl("button", { cls: "journal-reflect-model", attr: { type: "button" } });
			this.modelBadge.addEventListener("click", () => this.go({ kind: "settings" }));
			this.iconButton(title, "settings", "Reflection settings", () => this.go({ kind: "settings" }));
		}
	}

	/**
	 * Shows the model reflections use, quietly, since it is changed in the
	 * settings; with a warning while Ollama or the model cannot run one.
	 */
	private syncModelBadge(): void {
		const badge = this.modelBadge;
		if (!badge) return;
		badge.empty();
		const problem = this.problem();
		const checking = this.connection.state === "checking";
		badge.toggleClass("journal-reflect-model-warning", problem !== null);
		if (problem) setIcon(badge.createSpan({ cls: "journal-reflect-model-icon" }), "alert-triangle");
		const chosen = this.plugin.settings.reflectionModel;
		const name = this.model?.name ?? (chosen || (checking ? "Connecting…" : "No model"));
		badge.createSpan({ cls: "journal-reflect-model-name", text: name });
		const tooltip = problem ?? (checking ? "Connecting to Ollama…" : `Reflections use ${name}. Change it in the settings.`);
		setTooltip(badge, tooltip);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "clickable-icon journal-reflect-icon-button",
			attr: { type: "button", "aria-label": label },
		});
		setIcon(button, icon);
		setTooltip(button, label);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			onClick();
		});
		return button;
	}

	/* ---------------------------------------------------------- connection */

	/** Asks the server which models it has, and redraws what depends on the answer. */
	private async check(): Promise<void> {
		const serial = ++this.checkSerial;
		this.connection = { state: "checking" };
		this.connectionChanged();
		let next: Connection;
		try {
			const models = await this.plugin.reflectionProvider().listModels();
			next = models.length ? { state: "ready", models } : { state: "no-models" };
		} catch (error) {
			const message = describeProviderError(error);
			next =
				error instanceof ProviderError && error.kind === "unreachable"
					? { state: "unreachable", message }
					: { state: "failed", message };
		}
		if (this.closed || serial !== this.checkSerial) return;
		this.connection = next;
		this.connectionChanged();
	}

	private connectionChanged(): void {
		this.syncModelBadge();
		this.onConnection?.();
	}

	private get models(): ModelInfo[] {
		return this.connection.state === "ready" ? this.connection.models : [];
	}

	/**
	 * The model a reflection would use, as the runner picks it: the chosen
	 * one, or the first installed while none is chosen. Null while the chosen
	 * one is not installed, which a reflection would fail on.
	 */
	private get model(): ModelInfo | null {
		const models = this.models;
		const chosen = this.plugin.settings.reflectionModel;
		return chosen ? (models.find((model) => model.name === chosen) ?? null) : (models[0] ?? null);
	}

	/** The chosen model, while the server answers without it. */
	private get missingModel(): string | null {
		const chosen = this.plugin.settings.reflectionModel;
		return this.connection.state === "ready" && chosen && !this.model ? chosen : null;
	}

	/** Why a reflection cannot run now, or null when it can, or while that is not known yet. */
	private problem(): string | null {
		const { connection } = this;
		if (connection.state === "checking") return null;
		if (connection.state !== "ready") return this.connectionLine();
		const missing = this.missingModel;
		return missing ? `${missing} is not installed. Pull it, or choose another model in the settings.` : null;
	}

	/** The connection's one-line state, for the settings page. */
	private connectionLine(): string {
		const { connection } = this;
		switch (connection.state) {
			case "checking":
				return "Connecting…";
			case "ready":
				return `Connected · ${connection.models.length} ${connection.models.length === 1 ? "model" : "models"}`;
			case "no-models":
				return NO_MODELS_MESSAGE;
			default:
				return connection.message;
		}
	}

	/**
	 * What to do while the server cannot run a reflection: install and start
	 * Ollama, pull a model, try again. Empty once it can.
	 */
	private renderSetup(el: HTMLElement): void {
		el.empty();
		const { connection } = this;
		const missing = this.missingModel;
		el.hidden = (connection.state === "ready" && !missing) || connection.state === "checking";
		if (el.hidden) return;
		if (missing) {
			el.createDiv({ cls: "journal-reflect-setup-title", text: `${missing} is not installed.` });
			const steps = el.createEl("ol", { cls: "journal-reflect-setup-steps" });
			const pull = steps.createEl("li", { text: "Pull it in a terminal: " });
			pull.createEl("code").appendText(`${SETUP.pull}${missing}`);
			pull.appendText(".");
			steps.createEl("li", { text: "Or choose another model in the settings." });
		} else if (connection.state === "failed") {
			el.createDiv({ cls: "journal-reflect-setup-title", text: connection.message });
		} else {
			el.createDiv({
				cls: "journal-reflect-setup-title",
				text:
					connection.state === "unreachable"
						? `Nothing answers at ${this.plugin.settings.reflectionServer}.`
						: "Ollama answers, but has no model yet.",
			});
			const steps = el.createEl("ol", { cls: "journal-reflect-setup-steps" });
			if (connection.state === "unreachable") {
				const install = steps.createEl("li");
				install.appendText(SETUP.install);
				install.createEl("a", { text: "ollama.com", href: "https://ollama.com" });
				install.appendText(", and start it.");
			}
			const pull = steps.createEl("li", { text: "Pull a model in a terminal: " });
			pull.createEl("code").appendText(SETUP.pullSmall);
			pull.appendText(" for 16 GB of memory, or ");
			pull.createEl("code").appendText(SETUP.pullLarge);
			pull.appendText(" for 32 GB or more.");
		}
		const actions = el.createDiv({ cls: "journal-reflect-setup-actions" });
		const retry = actions.createEl("button", { text: "Try again", attr: { type: "button" } });
		retry.addEventListener("click", () => void this.check());
		if (this.page.kind === "ask") {
			const settings = actions.createEl("button", { text: "Settings", attr: { type: "button" } });
			settings.addEventListener("click", () => this.go({ kind: "settings" }));
		}
	}

	/* ------------------------------------------------------------------ ask */

	private renderAsk(): void {
		const { contentEl } = this;
		const setup = contentEl.createDiv({ cls: "journal-reflect-setup" });

		const composer = contentEl.createDiv({ cls: "journal-reflect-composer" });
		const input = composer.createEl("textarea", {
			cls: "journal-reflect-question",
			attr: { placeholder: "Ask your journal a question…", rows: "3", "aria-label": "Your question" },
		});
		input.value = draft.question;

		const row = composer.createDiv({ cls: "journal-reflect-composer-row" });
		const scopeSelect = row.createEl("select", { cls: "dropdown", attr: { "aria-label": "Notes to read" } });
		for (const [value, label] of Object.entries(SCOPE_CHOICES)) scopeSelect.createEl("option", { value, text: label });
		row.createDiv({ cls: "journal-reflect-spacer" });
		const save = this.iconButton(row, "bookmark-plus", "Save as preset", () => {
			const question = input.value.trim();
			if (!question) return;
			this.go({
				kind: "preset",
				isNew: true,
				back: "ask",
				preset: {
					id: newPresetId(),
					name: presetName(question),
					prompt: question,
					format: "",
					scope: choiceScope(this.choice === "range" ? DEFAULT_CHOICE : this.choice, this.today, null),
				},
			});
		});
		const create = row.createEl("button", { cls: "mod-cta", text: "Reflect", attr: { type: "button" } });

		const range = composer.createDiv({ cls: "journal-reflect-range" });
		range.createSpan({ text: "From" });
		const from = range.createEl("input", { attr: { type: "date", "aria-label": "From" } });
		range.createSpan({ text: "to" });
		const to = range.createEl("input", { attr: { type: "date", "aria-label": "To" } });
		from.value = draft.from ?? this.today.clone().subtract(13, "days").format(DAY_KEY_FORMAT);
		to.value = draft.to ?? this.today.format(DAY_KEY_FORMAT);
		const hint = composer.createDiv({ cls: "journal-reflect-hint" });

		contentEl.createDiv({ cls: "journal-reflect-section-title", text: "Presets" });
		const list = contentEl.createDiv({ cls: "journal-reflect-presets" });
		const presets = presetsOf(this.plugin.settings.reflectionPresets);
		const rows = presets.map((preset) => {
			const button = list.createEl("button", { cls: "journal-reflect-preset", attr: { type: "button" } });
			button.createSpan({ cls: "journal-reflect-preset-name", text: preset.name });
			const meta = button.createSpan({ cls: "journal-reflect-preset-meta", text: scopeLabel(preset.scope) });
			button.addEventListener("click", () => this.start(presetRequest(preset)));
			return { preset, button, meta, notes: null as number | null };
		});
		if (!presets.length) {
			list.createDiv({ cls: "journal-reflect-empty", text: "No presets. Add one in the settings." });
		}
		void Promise.all(
			rows.map(async (entry) => {
				if (entry.preset.scope.kind === "model") return;
				const summary = await summarizeScope(this.plugin, entry.preset.scope, this.today).catch(() => null);
				if (this.closed || !summary) return;
				entry.notes = summary.notes;
				entry.meta.setText(presetMeta(entry.preset.scope, summary));
				sync();
			}),
		);

		// The scope starts as last chosen; letting the model choose waits for the model.
		this.choice = draft.choice ?? DEFAULT_CHOICE;
		scopeSelect.value = this.choice;
		const canChoose = () => !!this.model?.tools;

		const scope = (): ReflectionScope | null => {
			if (this.choice !== "range") return choiceScope(this.choice, this.today, null);
			if (!isKey(from.value) || !isKey(to.value)) return null;
			return choiceScope("range", this.today, { from: from.value, to: to.value });
		};

		let size: { notes: number; words: number } | null = null;
		let sizing = false;
		const measure = (): void => {
			const serial = ++this.sizeSerial;
			const current = scope();
			size = null;
			sizing = !!current && current.kind !== "model";
			sync();
			if (!current || current.kind === "model") return;
			void summarizeScope(this.plugin, current, this.today)
				.catch(() => null)
				.then((summary) => {
					if (this.closed || serial !== this.sizeSerial) return;
					size = summary;
					sizing = false;
					sync();
				});
		};

		const sync = (): void => {
			this.renderSetup(setup);
			const ready = this.connection.state === "ready" && this.model !== null;
			// Scope
			const modelOption = scopeSelect.querySelector<HTMLOptionElement>('option[value="model"]');
			if (modelOption) {
				const blocked = ready && !canChoose();
				modelOption.disabled = blocked;
				modelOption.text = blocked ? `${SCOPE_CHOICES.model} (needs a model with tools)` : SCOPE_CHOICES.model;
			}
			if (ready && this.choice === "model" && !canChoose()) {
				this.choice = DEFAULT_CHOICE;
				scopeSelect.value = this.choice;
				measure();
				return;
			}
			range.hidden = this.choice !== "range";
			const current = scope();
			hint.setText(this.hintFor(current, size, sizing));
			hint.toggleClass("journal-reflect-hint-warning", !current || size?.notes === 0);
			const question = input.value.trim();
			create.disabled = !ready || !question || !current || size?.notes === 0;
			save.disabled = !question;
			for (const entry of rows) entry.button.disabled = !ready || entry.notes === 0;
		};

		input.addEventListener("input", () => {
			draft.question = input.value;
			sync();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			if (!create.disabled) create.click();
		});
		scopeSelect.addEventListener("change", () => {
			this.choice = scopeSelect.value as ScopeChoice;
			draft.choice = this.choice;
			measure();
			if (this.choice === "range") from.focus();
		});
		for (const field of [from, to]) {
			field.addEventListener("change", () => {
				draft.from = from.value;
				draft.to = to.value;
				measure();
			});
		}
		create.addEventListener("click", () => {
			const current = scope();
			const question = input.value.trim();
			if (!current || !question) return;
			draft.question = "";
			this.start(questionRequest(question, current));
		});

		this.onConnection = () => {
			// The first answer settles a scope that was waiting for the model.
			if (this.connection.state === "ready" && draft.choice === null && canChoose()) {
				this.choice = "model";
				scopeSelect.value = this.choice;
			}
			sync();
		};
		measure();
		window.setTimeout(() => input.focus(), 0);
	}

	private hintFor(scope: ReflectionScope | null, size: { notes: number; words: number } | null, sizing: boolean): string {
		if (!scope) return "Choose the first and last day to read.";
		if (scope.kind === "model") {
			return "The model searches and reads your notes itself, which takes longer.";
		}
		if (sizing) return "Counting the notes…";
		if (!size) return "";
		if (!size.notes) return "There are no notes to read there.";
		return `Reads ${size.notes} ${size.notes === 1 ? "note" : "notes"} · ~${roundWords(size.words)} words`;
	}

	private start(request: ReflectionRequest): void {
		this.plugin.reflectionRuns.start(request, this.today);
		this.close();
		this.options.onStart?.();
	}

	private setModel(name: string): void {
		this.plugin.settings.reflectionModel = name;
		this.persist(false);
	}

	/* ------------------------------------------------------------- settings */

	private renderSettings(): void {
		const { contentEl } = this;
		const { settings } = this.plugin;

		const server = new Setting(contentEl)
			.setName("Server")
			.setDesc(
				"The Ollama server reflections send the notes they read to. The default is on this computer; " +
					"nothing is sent anywhere else.",
			)
			.addText((text) => {
				text.setPlaceholder(DEFAULT_REFLECTION_SERVER).setValue(settings.reflectionServer);
				// Committed when the field is left, so the server is not asked at every keystroke.
				text.inputEl.addEventListener("change", () => {
					const value = reflectionServerSetting(text.getValue());
					text.setValue(value);
					if (value === settings.reflectionServer) return;
					settings.reflectionServer = value;
					this.persist(false);
					void this.check();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("Check the connection again")
					.onClick(() => void this.check()),
			);
		const status = server.descEl.createDiv({ cls: "journal-reflect-connection" });
		const setup = contentEl.createDiv({ cls: "journal-reflect-setup" });

		let modelSelect: HTMLSelectElement | null = null;
		new Setting(contentEl)
			.setName("Model")
			.setDesc(
				"Gemma 4 26B suits 32 GB of memory or more, and Gemma 4 E4B suits 16 GB. Only models with tools " +
					"can choose which notes to read.",
			)
			.addDropdown((dropdown) => {
				modelSelect = dropdown.selectEl;
				dropdown.onChange((value) => this.setModel(value));
			});

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Folder for reflection notes. It cannot be the daily-note folder.")
			.addText((text) => {
				text.setPlaceholder("Reflections").setValue(settings.reflectionFolder);
				text.inputEl.addEventListener("change", () => {
					const value = reflectionFolderSetting(text.getValue());
					text.setValue(value);
					if (value === settings.reflectionFolder) return;
					if (value === this.plugin.daily.config().folder) {
						new Notice("Journal view: reflections need a folder of their own, not the daily-note folder");
						text.setValue(settings.reflectionFolder);
						return;
					}
					settings.reflectionFolder = value;
					this.persist(true);
				});
			});

		new Setting(contentEl)
			.setName("Maximum context")
			.setDesc(
				"The most a reflection asks the model to hold, in tokens. Larger reads more notes before leaving " +
					"some out, and uses more memory.",
			)
			.addSlider((slider) => {
				slider
					.setLimits(MIN_REFLECTION_CONTEXT, MAX_REFLECTION_CONTEXT, REFLECTION_CONTEXT_STEP)
					.setValue(settings.reflectionMaxContext)
					.onChange((value) => {
						settings.reflectionMaxContext = clampReflectionContext(value);
						this.persist(false);
					});
				showSliderTooltip(slider);
			});

		contentEl.createDiv({ cls: "journal-reflect-section-title", text: "Presets" });
		const presets = contentEl.createDiv({ cls: "journal-reflect-preset-list" });
		this.renderPresetList(presets);

		this.onConnection = () => {
			status.setText(this.connectionLine());
			this.renderSetup(setup);
			const select = modelSelect;
			if (!select) return;
			select.empty();
			for (const model of this.models) select.createEl("option", { value: model.name, text: modelLabel(model) });
			const missing = this.missingModel;
			// Kept in the list, so the setting shows what reflections would ask for.
			if (missing) select.createEl("option", { value: missing, text: `${missing} (not installed)` });
			if (this.connection.state !== "ready") select.createEl("option", { value: "", text: "No models" });
			select.value = this.model?.name ?? missing ?? "";
			select.disabled = this.connection.state !== "ready";
		};
		this.onConnection();
	}

	private renderPresetList(el: HTMLElement): void {
		el.empty();
		const presets = [...presetsOf(this.plugin.settings.reflectionPresets)];
		presets.forEach((preset, index) => {
			const row = new Setting(el).setName(preset.name).setDesc(scopeName(preset.scope));
			row.settingEl.addClass("journal-reflect-preset-row");
			row.addExtraButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Move up")
					.setDisabled(index === 0)
					.onClick(() => this.savePresets(moved(presets, index, -1), el)),
			);
			row.addExtraButton((button) =>
				button
					.setIcon("arrow-down")
					.setTooltip("Move down")
					.setDisabled(index === presets.length - 1)
					.onClick(() => this.savePresets(moved(presets, index, 1), el)),
			);
			row.addExtraButton((button) =>
				button
					.setIcon("pencil")
					.setTooltip("Edit")
					.onClick(() => this.go({ kind: "preset", preset: { ...preset }, isNew: false, back: "settings" })),
			);
			row.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Delete")
					.onClick(() => this.savePresets(presets.filter((_, at) => at !== index), el)),
			);
		});
		if (!presets.length) {
			el.createDiv({ cls: "setting-item-description journal-reflect-empty", text: "No presets." });
		}
		new Setting(el)
			.addButton((button) =>
				button
					.setButtonText("Restore built-in presets")
					.setDisabled(!canRestoreBuiltIns(this.plugin.settings.reflectionPresets))
					.onClick(() => {
						this.plugin.settings.reflectionPresets = restoreBuiltIns(this.plugin.settings.reflectionPresets);
						this.persist(false);
						this.renderPresetList(el);
					}),
			)
			.addButton((button) =>
				button
					.setButtonText("New preset")
					.setCta()
					.onClick(() =>
						this.go({
							kind: "preset",
							isNew: true,
							back: "settings",
							preset: { id: newPresetId(), name: "", prompt: "", format: "", scope: { kind: "days", days: 14 } },
						}),
					),
			);
	}

	private savePresets(presets: ReflectionPreset[], el: HTMLElement | null): void {
		this.plugin.settings.reflectionPresets = presets;
		this.persist(false);
		if (el) this.renderPresetList(el);
	}

	/* ----------------------------------------------------------- one preset */

	private renderPreset(page: Extract<Page, { kind: "preset" }>): void {
		const { contentEl } = this;
		const preset = page.preset;

		new Setting(contentEl).setName("Name").addText((text) =>
			text
				.setPlaceholder("Looking back")
				.setValue(preset.name)
				.onChange((value) => {
					preset.name = value;
					sync();
				}),
		);

		const question = new Setting(contentEl).setName("Question").setDesc("What the model is asked.");
		question.settingEl.addClass("journal-reflect-wide-setting");
		question.addTextArea((text) =>
			text
				.setPlaceholder("What changed for me this month, and why?")
				.setValue(preset.prompt)
				.onChange((value) => {
					preset.prompt = value;
					sync();
				}),
		);

		const shape = new Setting(contentEl)
			.setName("Answer shape")
			.setDesc(
				"How the answer is laid out, such as bullets with the link of the note each comes from. Optional; " +
					"without one, the model answers in a few short paragraphs or bullets, citing its notes.",
			);
		shape.settingEl.addClass("journal-reflect-wide-setting");
		shape.addTextArea((text) =>
			text
				.setPlaceholder("Answer with one to three bullets, each with the link of its note.")
				.setValue(preset.format)
				.onChange((value) => {
					preset.format = value;
				}),
		);

		const options: Record<string, string> = {};
		for (const scope of PRESET_SCOPES) options[scopeKey(scope)] = scopeName(scope);
		options[scopeKey(preset.scope)] = scopeName(preset.scope);
		new Setting(contentEl)
			.setName("Reads")
			.setDesc("The notes it reads, counted back from the day it is made.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(options)
					.setValue(scopeKey(preset.scope))
					.onChange((value) => {
						const scope = scopeFromKey(value);
						if (scope) preset.scope = scope;
					}),
			);

		let saveButton: HTMLButtonElement | null = null;
		const actions = new Setting(contentEl);
		actions.settingEl.addClass("journal-reflect-preset-actions");
		if (!page.isNew) {
			actions.addButton((button) => {
				// `setWarning` is deprecated, and `setDestructive` is newer than the plugin's minimum.
				button.buttonEl.addClass("mod-warning");
				button.setButtonText("Delete").onClick(() => {
					const presets = presetsOf(this.plugin.settings.reflectionPresets).filter(
						(other) => other.id !== preset.id,
					);
					this.savePresets(presets, null);
					this.go({ kind: page.back });
				});
			});
		}
		actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.go({ kind: page.back })));
		actions.addButton((button) => {
			saveButton = button.buttonEl;
			button
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					const saved: ReflectionPreset = {
						...preset,
						name: preset.name.trim(),
						prompt: preset.prompt.trim(),
						format: preset.format.trim(),
					};
					if (!saved.name || !saved.prompt) return;
					const presets = [...presetsOf(this.plugin.settings.reflectionPresets)];
					const at = presets.findIndex((other) => other.id === saved.id);
					if (at === -1) presets.push(saved);
					else presets[at] = saved;
					this.savePresets(presets, null);
					this.go({ kind: page.back });
				});
		});

		const sync = (): void => {
			if (saveButton) saveButton.disabled = !preset.name.trim() || !preset.prompt.trim();
		};
		sync();
	}

	/* ---------------------------------------------------------------- saving */

	/** Saves the settings in order; folder changes redraw the journal, the rest need not. */
	private persist(notifyViews: boolean): void {
		this.saving = this.saving
			.then(() => this.plugin.saveSettings(notifyViews))
			.catch((error: unknown) => {
				console.error("Journal View: could not save the reflection settings", error);
				new Notice("Journal view: could not save the reflection settings");
			});
	}
}

/** The ranges a preset can read, as the preset editor offers them. */
const PRESET_SCOPES: readonly ReflectionScope[] = [
	{ kind: "model" },
	{ kind: "days", days: 7 },
	{ kind: "days", days: 14 },
	{ kind: "days", days: 30 },
	{ kind: "days", days: 30, beforeToday: true },
	{ kind: "days", days: 90 },
	{ kind: "this-day" },
];

function scopeKey(scope: ReflectionScope): string {
	switch (scope.kind) {
		case "days":
			return `${scope.beforeToday ? "before" : "days"}:${scope.days}`;
		case "range":
			return `range:${scope.from}:${scope.to}`;
		default:
			return scope.kind;
	}
}

function scopeFromKey(key: string): ReflectionScope | null {
	if (key === "model" || key === "this-day") return { kind: key };
	const [kind, first, second] = key.split(":");
	if (kind === "range" && isKey(first) && isKey(second)) return { kind: "range", from: first, to: second };
	const days = Number(first);
	if (!Number.isInteger(days) || days < 1) return null;
	if (kind === "days") return { kind: "days", days };
	if (kind === "before") return { kind: "days", days, beforeToday: true };
	return null;
}

/** "Last 14 days", "The 30 days before today", "This day over the years". */
function scopeName(scope: ReflectionScope): string {
	switch (scope.kind) {
		case "model":
			return SCOPE_CHOICES.model;
		case "this-day":
			return "This date in every earlier year, and today";
		case "range":
			return `${scope.from} – ${scope.to}`;
		case "days":
			if (scope.beforeToday) return `The ${scope.days} days before today`;
			return scope.days === 1 ? "Today" : `Last ${scope.days} days`;
	}
}

/** The scope a choice on the ask page reads. */
function choiceScope(choice: ScopeChoice, today: Moment, range: { from: string; to: string } | null): ReflectionScope {
	switch (choice) {
		case "model":
			return { kind: "model" };
		case "this-day":
			return { kind: "this-day" };
		case "range": {
			const key = today.format(DAY_KEY_FORMAT);
			return { kind: "range", from: range?.from ?? key, to: range?.to ?? key };
		}
		default:
			return { kind: "days", days: Number(choice.slice("days:".length)) };
	}
}

function isKey(value: string | undefined): value is string {
	return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && createMoment(value, DAY_KEY_FORMAT, true).isValid();
}

/** A model's name in a picker, saying when it cannot choose its own notes. */
function modelLabel(model: ModelInfo): string {
	return model.tools ? model.name : `${model.name} (no tools)`;
}

/** "14 days · ~3k words", or "4 notes" for this date over the years. */
function presetMeta(scope: ReflectionScope, summary: { notes: number; words: number }): string {
	const parts = [scopeLabel(scope)].filter(Boolean);
	if (scope.kind === "this-day") parts.push(summary.notes === 1 ? "1 note" : `${summary.notes} notes`);
	else parts.push(summary.notes === 0 ? "no notes" : `~${roundWords(summary.words)} words`);
	return parts.join(" · ");
}

function roundWords(words: number): string {
	if (words < 1000) return String(Math.max(10, Math.round(words / 10) * 10));
	return `${Math.round(words / 1000)}k`;
}

/** A preset's name from the question it saves: its first few words. */
function presetName(question: string): string {
	const words = question.replace(/\s+/g, " ").trim().split(" ");
	const name = words.slice(0, 6).join(" ");
	return words.length > 6 ? `${name}…` : name;
}

function newPresetId(): string {
	return `own-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
	const next = [...items];
	const target = index + by;
	if (target < 0 || target >= next.length) return next;
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}
