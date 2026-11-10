import { Modal, Notice, Setting, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import type { Moment } from "../moment";
import { noteBody } from "../noteBody";
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
import { parseConversation } from "./conversation";
import { canRestoreBuiltIns, presetRequest, presetsOf, questionRequest, restoreBuiltIns } from "./presets";
import type { ReflectionPreset, ReflectionRequest } from "./presets";
import {
	NO_MODELS_MESSAGE,
	ProviderError,
	SUGGESTED_EMBEDDING_MODEL,
	SUGGESTED_MODEL,
	defaultEmbeddingModel,
	defaultModel,
	describeProviderError,
} from "./provider";
import type { ModelInfo } from "./provider";
import type { IndexStatus } from "./semanticStore";
import type { StoredReflection } from "./store";

export interface ReflectionModalOptions {
	/** Called once a reflection has started, after the window closes. */
	onStart?: () => void;
	onClose?: () => void;
	/**
	 * A reflection to ask again: the window opens on its question, to change
	 * it or the model before the new answer replaces the old one.
	 */
	regenerate?: StoredReflection;
}

/** Where the window is: asking, asking a reflection again, its settings, or one preset being edited. */
type Page =
	| { kind: "ask" }
	| { kind: "regenerate"; reflection: StoredReflection }
	| { kind: "settings" }
	| { kind: "preset"; preset: ReflectionPreset; isNew: boolean; back: "ask" | "settings" };

/** What the model server said when it was last asked. */
type Connection =
	| { state: "checking" }
	| { state: "ready"; models: ModelInfo[]; embedding: string[] }
	| { state: "unreachable"; message: string }
	| { state: "no-models" }
	| { state: "failed"; message: string };

/** The setup steps' names and commands, written as they are. */
const SETUP = {
	install: "Install Ollama from ",
	pull: "ollama pull ",
};

/**
 * The question being written, kept while the plugin runs, so closing the
 * window by accident does not lose it. Cleared once it is asked.
 */
const draft = { question: "" };

/**
 * The Reflect window, opened from today's button and the Create reflection
 * command. It asks a question of the reader's own, or runs a preset at a
 * click; either way the model finds the notes the question is about. Its
 * settings page holds the connection, the model, the folder and the
 * presets, which the plugin's settings tab leaves to it.
 *
 * Opened from a reflection's Regenerate button, it holds that reflection's
 * question instead, and the model to ask it of, and no presets.
 */
export class ReflectionModal extends Modal {
	private page: Page;
	private connection: Connection = { state: "checking" };
	/** Bumped by every check, so an older answer arriving late is dropped. */
	private checkSerial = 0;
	private readonly today: Moment = createMoment().startOf("day");
	private saving: Promise<void> = Promise.resolve();
	private closed = false;
	/** Redraws what on the current page depends on the connection. */
	private onConnection: (() => void) | null = null;
	/** The model reflections use, beside the settings button on the first page. */
	private modelBadge: HTMLElement | null = null;
	/** Stops hearing of the index being built, once the settings page that shows it is left. */
	private offIndex: (() => void) | null = null;
	private indexSerial = 0;

	constructor(
		app: App,
		private plugin: JournalViewPlugin,
		private options: ReflectionModalOptions = {},
	) {
		super(app);
		this.page = options.regenerate ? { kind: "regenerate", reflection: options.regenerate } : { kind: "ask" };
	}

	onOpen(): void {
		this.modalEl.addClass("journal-reflect-modal");
		this.render();
		void this.check();
	}

	onClose(): void {
		this.closed = true;
		this.onConnection = null;
		this.offIndex?.();
		this.offIndex = null;
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
		this.offIndex?.();
		this.offIndex = null;
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
			case "regenerate":
				this.renderRegenerate(this.page.reflection);
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
			const { chat, embedding } = await this.plugin.reflectionProvider().listInstalled();
			next = chat.length ? { state: "ready", models: chat, embedding } : { state: "no-models" };
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
	 * one, or while none is chosen the default among those installed. Null
	 * while the chosen one is not installed, which a reflection would fail on.
	 */
	private get model(): ModelInfo | null {
		const models = this.models;
		const chosen = this.plugin.settings.reflectionModel;
		return chosen ? (models.find((model) => model.name === chosen) ?? null) : defaultModel(models);
	}

	/** The model a reflection would use, while it cannot use tools and so cannot read the journal. */
	private get toollessModel(): string | null {
		const model = this.model;
		return model && !model.tools ? model.name : null;
	}

	/** True once a reflection can run: Ollama answers, and the model is installed and can use tools. */
	private get ready(): boolean {
		return this.connection.state === "ready" && !!this.model?.tools;
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
		if (missing) return `${missing} is not installed. Pull it, or choose another model in the settings.`;
		const toolless = this.toollessModel;
		return toolless
			? `${toolless} cannot use tools, which a reflection needs to read your journal. Choose another model in the settings.`
			: null;
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
	 * What to do while a reflection cannot run: install and start Ollama, pull
	 * a model, choose one that can use tools, try again. Empty once it can.
	 */
	private renderSetup(el: HTMLElement): void {
		el.empty();
		const { connection } = this;
		const missing = this.missingModel;
		const toolless = this.toollessModel;
		el.hidden = (connection.state === "ready" && !missing && !toolless) || connection.state === "checking";
		if (el.hidden) return;
		const suggest = (item: HTMLElement): void => {
			item.createEl("code").appendText(`${SETUP.pull}${SUGGESTED_MODEL}`);
			item.appendText(", which suits 32 GB of memory or more. Smaller models find and read notes less reliably.");
		};
		if (missing) {
			el.createDiv({ cls: "journal-reflect-setup-title", text: `${missing} is not installed.` });
			const steps = el.createEl("ol", { cls: "journal-reflect-setup-steps" });
			const pull = steps.createEl("li", { text: "Pull it in a terminal: " });
			pull.createEl("code").appendText(`${SETUP.pull}${missing}`);
			pull.appendText(".");
			steps.createEl("li", { text: "Or choose another model in the settings." });
		} else if (toolless) {
			el.createDiv({ cls: "journal-reflect-setup-title", text: `${toolless} cannot use tools.` });
			const steps = el.createEl("ol", { cls: "journal-reflect-setup-steps" });
			steps.createEl("li", {
				text: `A reflection's model finds and reads your notes through tools. Choose a model that has them ${this.page.kind === "ask" ? "in the settings" : "below"}.`,
			});
			suggest(steps.createEl("li", { text: "Or pull one in a terminal: " }));
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
			suggest(steps.createEl("li", { text: "Pull a model in a terminal: " }));
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
		// Where the notes to read used to be chosen: the question says it now.
		row.createDiv({
			cls: "journal-reflect-hint",
			text: "The model finds the notes itself: name a time, a person or a subject.",
		});
		const save = this.iconButton(row, "bookmark-plus", "Save as preset", () => {
			const question = input.value.trim();
			if (!question) return;
			this.go({
				kind: "preset",
				isNew: true,
				back: "ask",
				preset: { id: newPresetId(), name: presetName(question), prompt: question, format: "" },
			});
		});
		const create = row.createEl("button", { cls: "mod-cta", text: "Reflect", attr: { type: "button" } });

		contentEl.createDiv({ cls: "journal-reflect-section-title", text: "Presets" });
		const list = contentEl.createDiv({ cls: "journal-reflect-presets" });
		const presets = presetsOf(this.plugin.settings.reflectionPresets);
		const buttons = presets.map((preset) => {
			const button = list.createEl("button", { cls: "journal-reflect-preset", attr: { type: "button" } });
			button.createSpan({ cls: "journal-reflect-preset-name", text: preset.name });
			// The question says what it reads, such as "over the last two weeks".
			button.createSpan({ cls: "journal-reflect-preset-meta", text: preset.prompt });
			button.addEventListener("click", () => this.start(presetRequest(preset)));
			return button;
		});
		if (!presets.length) {
			list.createDiv({ cls: "journal-reflect-empty", text: "No presets. Add one in the settings." });
		}

		const sync = (): void => {
			this.renderSetup(setup);
			const question = input.value.trim();
			create.disabled = !this.ready || !question;
			save.disabled = !question;
			for (const button of buttons) button.disabled = !this.ready;
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
		create.addEventListener("click", () => {
			const question = input.value.trim();
			if (!question) return;
			draft.question = "";
			this.start(questionRequest(question));
		});

		this.onConnection = sync;
		sync();
		window.setTimeout(() => input.focus(), 0);
	}

	/* ----------------------------------------------------------- regenerate */

	/**
	 * A reflection's question, to change before it is asked again, and the
	 * model to ask: the one reflections use unless another is picked, which
	 * holds for this answer alone.
	 */
	private renderRegenerate(reflection: StoredReflection): void {
		const { contentEl } = this;
		// The model sits where the first page names it, as quietly, but can be picked here.
		const title = this.titleEl.createDiv({ cls: "journal-reflect-title" });
		title.createSpan({ cls: "journal-reflect-title-text", text: "Regenerate" });
		const select = title.createEl("select", {
			cls: "journal-reflect-model-select",
			attr: { "aria-label": "Model for this answer" },
		});
		setTooltip(select, "The model that writes this answer");
		const setup = contentEl.createDiv({ cls: "journal-reflect-setup" });

		const composer = contentEl.createDiv({ cls: "journal-reflect-composer" });
		const input = composer.createEl("textarea", {
			cls: "journal-reflect-question",
			attr: { placeholder: "Ask your journal a question…", rows: "3", "aria-label": "The question" },
		});
		input.value = reflection.prompt;

		const row = composer.createDiv({ cls: "journal-reflect-composer-row" });
		const note = row.createDiv({ cls: "journal-reflect-hint", text: "The new answer replaces this one." });
		const regenerate = row.createEl("button", { cls: "mod-cta", text: "Regenerate", attr: { type: "button" } });

		// Follow-ups are answers to the old answer, so they go with it.
		void this.app.vault
			.cachedRead(reflection.file)
			.then((text) => {
				const followUps = parseConversation(noteBody(text), reflection.followUps).followUps.length;
				if (this.closed || !followUps) return;
				note.setText(
					`The new answer replaces this one, and its ${followUps === 1 ? "follow-up" : `${followUps} follow-ups`}.`,
				);
			})
			.catch((error: unknown) => console.error(`Journal View: could not read ${reflection.file.path}`, error));

		/** The model picked here, by name; until one is, the one reflections use. */
		let picked: string | null = null;
		const chosen = (): ModelInfo | null => {
			const models = this.models;
			const usual = this.model?.tools ? this.model : (models.find((model) => model.tools) ?? null);
			return (picked ? models.find((model) => model.name === picked && model.tools) : null) ?? usual;
		};

		const sync = (): void => {
			const model = chosen();
			const ready = this.connection.state === "ready" && model !== null;
			// What is wrong with the model reflections use does not matter once another is picked here.
			if (ready || this.connection.state === "checking") setup.hidden = true;
			else this.renderSetup(setup);
			select.empty();
			for (const candidate of this.models) {
				const option = select.createEl("option", { value: candidate.name, text: modelLabel(candidate) });
				option.disabled = !candidate.tools;
			}
			if (!this.models.length) {
				select.createEl("option", { value: "", text: this.connection.state === "checking" ? "Connecting…" : "No models" });
			}
			select.value = model?.name ?? "";
			select.disabled = !this.models.length;
			regenerate.disabled = !ready || !input.value.trim();
		};

		select.addEventListener("change", () => {
			picked = select.value;
			sync();
		});
		input.addEventListener("input", () => {
			regenerate.disabled = !(this.connection.state === "ready" && chosen()) || !input.value.trim();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			if (!regenerate.disabled) regenerate.click();
		});
		regenerate.addEventListener("click", () => {
			const model = chosen();
			const prompt = input.value.trim();
			if (!model || !prompt) return;
			this.plugin.reflectionRuns.regenerate(reflection, { prompt, model: model.name });
			this.close();
		});

		this.onConnection = sync;
		sync();
		window.setTimeout(() => {
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		}, 0);
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
					this.plugin.reflectionIndex.settingsChanged();
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
				"A reflection's model finds and reads your notes through tools, so it has to support them. " +
					"Gemma 4 26B suits 32 GB of memory or more; smaller models find and read notes less reliably.",
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
				"The most a reflection asks the model to hold, in tokens. Larger lets it read more notes for one " +
					"answer, and uses more memory.",
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

		contentEl.createDiv({ cls: "journal-reflect-section-title", text: "Search by meaning" });
		const semantic = contentEl.createDiv({ cls: "journal-reflect-semantic" });

		contentEl.createDiv({ cls: "journal-reflect-section-title", text: "Presets" });
		const presets = contentEl.createDiv({ cls: "journal-reflect-preset-list" });
		this.renderPresetList(presets);

		this.onConnection = () => {
			status.setText(this.connectionLine());
			this.renderSetup(setup);
			// Its model picker lists what the server has.
			this.renderSemantic(semantic);
			const select = modelSelect;
			if (!select) return;
			select.empty();
			for (const model of this.models) {
				const option = select.createEl("option", { value: model.name, text: modelLabel(model) });
				// Kept in the list, so it is clear why it cannot be chosen.
				option.disabled = !model.tools;
			}
			const missing = this.missingModel;
			// Kept in the list, so the setting shows what reflections would ask for.
			if (missing) select.createEl("option", { value: missing, text: `${missing} (not installed)` });
			if (this.connection.state !== "ready") select.createEl("option", { value: "", text: "No models" });
			select.value = this.model?.name ?? missing ?? "";
			select.disabled = this.connection.state !== "ready";
		};
		this.onConnection();
	}

	/**
	 * Search by meaning: its switch, and while it is on the embedding model
	 * and the index, with what the index holds and a way to build it now
	 * rather than at the next reflection.
	 */
	private renderSemantic(el: HTMLElement): void {
		el.empty();
		this.offIndex?.();
		this.offIndex = null;
		const { settings, reflectionIndex } = this.plugin;
		new Setting(el)
			.setName("Search by meaning")
			.setDesc(
				"Lets a reflection find notes that are about what you asked without using its words: a search for " +
					"exercise also finds the days you went running. A second, small model reads each note on this " +
					"computer and turns it into numbers, kept in an index file in the plugin's folder, about a " +
					"kilobyte a note. The first build takes a moment; after it only new and changed notes are read. " +
					"Turning this off deletes the index.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.reflectionSemantic).onChange((value) => {
					settings.reflectionSemantic = value;
					this.persist(false);
					// Nothing is kept once it is off.
					void (value ? Promise.resolve() : reflectionIndex.remove()).then(() => {
						if (!this.closed && this.page.kind === "settings") this.renderSemantic(el);
					});
				}),
			);
		if (!settings.reflectionSemantic) return;

		const installed = this.connection.state === "ready" ? this.connection.embedding : [];
		const chosen = settings.reflectionEmbeddingModel;
		const missing = this.connection.state === "ready" && chosen && !installed.includes(chosen) ? chosen : null;
		if (this.connection.state === "ready" && (missing || !installed.length)) {
			const box = el.createDiv({ cls: "journal-reflect-setup" });
			box.createDiv({
				cls: "journal-reflect-setup-title",
				text: missing ? `${missing} is not installed.` : "No embedding model is installed yet.",
			});
			const steps = box.createEl("ol", { cls: "journal-reflect-setup-steps" });
			const pull = steps.createEl("li", { text: "Pull one in a terminal: " });
			pull.createEl("code").appendText(`${SETUP.pull}${missing ?? SUGGESTED_EMBEDDING_MODEL}`);
			pull.appendText(missing ? "." : ", about 400 MB. It reads over a hundred languages.");
			steps.createEl("li", { text: "Until then, reflections search by words alone." });
			const actions = box.createDiv({ cls: "journal-reflect-setup-actions" });
			actions.createEl("button", { text: "Try again", attr: { type: "button" } }).addEventListener("click", () => void this.check());
		}

		new Setting(el)
			.setName("Embedding model")
			.setDesc(
				"The model that turns notes into numbers. EmbeddingGemma 2 (270M) is the suggestion: of those tried it " +
					"found the most, and its larger versions add nothing for text. Changing the model builds the index again.",
			)
			.addDropdown((dropdown) => {
				const select = dropdown.selectEl;
				for (const model of installed) select.createEl("option", { value: model, text: model });
				if (missing) select.createEl("option", { value: missing, text: `${missing} (not installed)` });
				if (!installed.length && !missing) {
					select.createEl("option", { value: "", text: this.connection.state === "checking" ? "Connecting…" : "No embedding models" });
				}
				select.value = chosen || defaultEmbeddingModel(installed) || "";
				select.disabled = !installed.length;
				dropdown.onChange((value) => {
					if (value === (settings.reflectionEmbeddingModel || defaultEmbeddingModel(installed))) return;
					settings.reflectionEmbeddingModel = value;
					this.persist(false);
					// Another model's numbers cannot be compared with these.
					void reflectionIndex.remove().then(() => reflectionIndex.settingsChanged());
				});
			});

		const index = new Setting(el).setName("Index");
		index.settingEl.addClass("journal-reflect-index");
		const line = index.descEl.createDiv({ cls: "journal-reflect-index-status" });
		index.descEl.createDiv({ cls: "journal-reflect-index-path", text: `Kept in ${reflectionIndex.path()}` });
		let build: HTMLButtonElement | null = null;
		let rebuild: HTMLElement | null = null;
		let building = false;
		index.addExtraButton((button) => {
			rebuild = button.extraSettingsEl;
			button
				.setIcon("rotate-ccw")
				.setTooltip("Build the index again from nothing")
				.onClick(() => void reflectionIndex.remove().then(() => reflectionIndex.build()));
		});
		index.addButton((button) => {
			build = button.buttonEl;
			button.onClick(() => {
				if (building) reflectionIndex.stop();
				else void reflectionIndex.build();
			});
		});

		const show = async (): Promise<void> => {
			const serial = ++this.indexSerial;
			const status = await reflectionIndex.status();
			if (this.closed || serial !== this.indexSerial || !line.isConnected) return;
			building = status.state === "building";
			line.toggleClass("journal-reflect-index-failed", status.state === "failed");
			line.setText(indexLine(status));
			if (rebuild) rebuild.toggleClass("journal-reflect-hidden", building || status.state === "none");
			if (!build) return;
			const upToDate = status.state === "ready" && status.stale === 0;
			build.toggleClass("journal-reflect-hidden", upToDate);
			build.setText(building ? "Stop" : status.state === "ready" ? "Update now" : status.state === "failed" ? "Try again" : "Build now");
			build.disabled = !building && !installed.length;
		};
		this.offIndex = reflectionIndex.onChanged(() => void show());
		void show();
	}

	private renderPresetList(el: HTMLElement): void {
		el.empty();
		const presets = [...presetsOf(this.plugin.settings.reflectionPresets)];
		presets.forEach((preset, index) => {
			const row = new Setting(el).setName(preset.name).setDesc(preset.prompt);
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
							preset: { id: newPresetId(), name: "", prompt: "", format: "" },
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

		const question = new Setting(contentEl)
			.setName("Question")
			.setDesc(
				"What the model is asked. Say which notes it is about, such as the last two weeks, a person or a " +
					"subject: the model finds them itself.",
			);
		question.settingEl.addClass("journal-reflect-wide-setting");
		question.addTextArea((text) =>
			text
				.setPlaceholder("What changed for me over the last month, and why?")
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

/** What the settings say of the index: how much it holds, what made it, and what is left to do. */
function indexLine(status: IndexStatus): string {
	const notes = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;
	switch (status.state) {
		case "none":
			return `Not built yet: ${notes(status.notes)} to read. It is built the first time a reflection searches, or now.`;
		case "building":
			return `Reading ${status.done} of ${notes(status.total)}…`;
		case "failed":
			return status.message;
		case "ready": {
			const size = status.bytes < 1e6 ? `${Math.max(1, Math.round(status.bytes / 1e3))} KB` : `${(status.bytes / 1e6).toFixed(1)} MB`;
			const rest = status.stale ? `${status.stale} new or changed, read at the next search` : "up to date";
			return `${notes(status.indexed)} · ${size} · ${status.model} · ${rest}`;
		}
	}
}

/** A model's name in a picker, saying when it cannot read the journal. */
function modelLabel(model: ModelInfo): string {
	return model.tools ? model.name : `${model.name} (cannot use tools)`;
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
