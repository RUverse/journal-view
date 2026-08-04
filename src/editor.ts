import { App, TFile } from "obsidian";

export interface JournalEditorOptions {
	app: App;
	container: HTMLElement;
	value: string;
	placeholder: string;
	/** The note being edited, when it already exists. Used for link resolution. */
	file: TFile | null;
	onChange: () => void;
	onFocus: () => void;
	onBlur: () => void;
}

export interface JournalEditor {
	getValue(): string;
	setValue(value: string): void;
	setFile(file: TFile | null): void;
	focus(): void;
	hasFocus(): boolean;
	destroy(): void;
	/** Moves the cursor to the position nearest the given window coordinates. */
	placeCursor?(x: number, y: number): void;
	/** Moves the cursor past everything the editor holds. */
	placeCursorAtEnd?(): void;
	/** True when this is Obsidian's own editor rather than the plain fallback. */
	rich: boolean;
}

/* -------------------------------------------------------------------------- */
/* Obsidian's own markdown editor                                             */
/* -------------------------------------------------------------------------- */

interface InternalCodeMirror {
	posAtCoords?(coords: { x: number; y: number }, precise: boolean): number | null;
	dispatch?(spec: { selection: { anchor: number } }): void;
	/** CodeMirror's pending "bring the cursor into view" request, if any. */
	viewState?: { scrollTarget?: unknown };
}

interface InternalEditorApi {
	cm?: InternalCodeMirror;
	getSelection?(): string;
	getValue?(): string;
	focus?(): void;
}

interface InternalEditorInstance {
	editor?: InternalEditorApi;
	get?(): string | null;
	set?(value: string, clear: boolean): void;
	onUpdate?(update: unknown, changed: boolean): void;
	destroy?(): void;
	unload?(): void;
}

interface InternalEditorOwner {
	app: App;
	file: TFile | null;
	hoverPopover: null;
	getMode(): string;
	getFile(): TFile | null;
	getSelection(): string;
	onMarkdownScroll(): undefined;
	onMarkdownFold(): undefined;
	showSearch(): undefined;
	toggleMode(): undefined;
	editor?: InternalEditorApi;
}

type EditorCtor = new (app: App, container: HTMLElement, owner: InternalEditorOwner) => InternalEditorInstance;

let cachedCtor: EditorCtor | null | undefined;

/**
 * Obsidian does not export its embeddable markdown editor, but it hands one out
 * through the embed registry. We borrow the constructor once and reuse it.
 * Everything is guarded - if the shape ever changes we fall back to a textarea.
 */
function resolveEditorCtor(app: App): EditorCtor | null {
	if (cachedCtor !== undefined) return cachedCtor;

	cachedCtor = null;
	try {
		const factory = app.embedRegistry?.embedByExtension?.["md"];
		if (!factory) return cachedCtor;

		const candidate = factory({ app, containerEl: createDiv() }, null, "");
		if (!candidate || typeof candidate !== "object") return cachedCtor;
		const probe = candidate as Record<string, unknown>;
		probe.editable = true;
		if (typeof probe.showEditor === "function") probe.showEditor.call(probe);
		const editMode = probe.editMode;
		if (editMode) {
			const proto = Object.getPrototypeOf(Object.getPrototypeOf(editMode));
			if (typeof proto?.constructor === "function") {
				cachedCtor = proto.constructor as EditorCtor;
			}
		}
		if (typeof probe.unload === "function") probe.unload.call(probe);
	} catch (error) {
		console.warn("Journal View: Obsidian's embedded editor is unavailable, using the plain editor", error);
		cachedCtor = null;
	}
	return cachedCtor;
}

class RichEditor implements JournalEditor {
	readonly rich = true;
	private instance: InternalEditorInstance | null;
	private owner: InternalEditorOwner;
	private focusIn: () => void;
	private focusOut: () => void;

	constructor(
		private options: JournalEditorOptions,
		Ctor: EditorCtor,
	) {
		this.owner = {
			app: options.app,
			file: options.file,
			hoverPopover: null,
			getMode: () => "source",
			getFile: () => this.options.file,
			getSelection: () => this.instance?.editor?.getSelection?.() ?? "",
			onMarkdownScroll: () => undefined,
			onMarkdownFold: () => undefined,
			showSearch: () => undefined,
			toggleMode: () => undefined,
		};

		this.instance = new Ctor(options.app, options.container, this.owner);

		// Makes the owner usable as a MarkdownFileInfo, so Obsidian's editor
		// commands (bold, link, templates, ...) can target this day.
		Object.defineProperty(this.owner, "editor", {
			configurable: true,
			get: () => this.instance?.editor,
		});

		const original = this.instance.onUpdate?.bind(this.instance);
		this.instance.onUpdate = (update: unknown, changed: boolean) => {
			original?.(update, changed);
			if (changed) this.options.onChange();
		};

		this.instance.set?.(options.value, true);
		this.dropScrollRequest();

		this.focusIn = () => {
			this.claimActiveEditor(true);
			this.options.onFocus();
		};
		this.focusOut = () => {
			this.claimActiveEditor(false);
			this.options.onBlur();
		};
		options.container.addEventListener("focusin", this.focusIn);
		options.container.addEventListener("focusout", this.focusOut);
	}

	private claimActiveEditor(claim: boolean): void {
		try {
			const workspace = this.options.app.workspace as unknown as { activeEditor: unknown };
			if (claim) workspace.activeEditor = this.owner;
			else if (workspace.activeEditor === this.owner) workspace.activeEditor = null;
		} catch (error) {
			console.warn("Journal View: could not hand the editor to the workspace", error);
		}
	}

	getValue(): string {
		try {
			if (typeof this.instance?.get === "function") return this.instance.get() ?? "";
			return this.instance?.editor?.getValue?.() ?? "";
		} catch (error) {
			console.warn("Journal View: could not read editor contents", error);
			return "";
		}
	}

	setValue(value: string): void {
		try {
			this.instance?.set?.(value, true);
			this.dropScrollRequest();
		} catch (error) {
			console.warn("Journal View: could not update editor contents", error);
		}
	}

	/**
	 * Giving an editor its content asks CodeMirror to scroll the cursor into
	 * view. The journal builds editors for days that are deliberately off
	 * screen, and CodeMirror obliges by scrolling the whole pane to them -
	 * which reads as the journal lurching to a day the reader was only
	 * approaching. The request is only carried out in a later measure pass, so
	 * dropping it here is enough. Focusing a day still scrolls to it, which is
	 * the one case that is meant to.
	 */
	private dropScrollRequest(): void {
		try {
			const viewState = this.instance?.editor?.cm?.viewState;
			if (viewState && "scrollTarget" in viewState) viewState.scrollTarget = null;
		} catch {
			/* the view's own guard catches the scroll if this ever stops working */
		}
	}

	setFile(file: TFile | null): void {
		this.options.file = file;
		this.owner.file = file;
	}

	focus(): void {
		try {
			this.instance?.editor?.focus?.();
		} catch (error) {
			console.warn("Journal View: could not focus editor", error);
		}
	}

	placeCursor(x: number, y: number): void {
		try {
			const cm = this.instance?.editor?.cm;
			const pos = cm?.posAtCoords?.({ x, y }, false);
			if (typeof pos === "number") cm?.dispatch?.({ selection: { anchor: pos } });
		} catch {
			/* the cursor stays wherever focus put it */
		}
	}

	placeCursorAtEnd(): void {
		try {
			this.instance?.editor?.cm?.dispatch?.({ selection: { anchor: this.getValue().length } });
			this.dropScrollRequest();
		} catch {
			/* the cursor stays wherever focus put it */
		}
	}

	hasFocus(): boolean {
		const active = this.options.container.ownerDocument.activeElement;
		return !!active && this.options.container.contains(active);
	}

	destroy(): void {
		this.claimActiveEditor(false);
		this.options.container.removeEventListener("focusin", this.focusIn);
		this.options.container.removeEventListener("focusout", this.focusOut);
		try {
			this.instance?.destroy?.();
		} catch (error) {
			console.warn("Journal View: editor teardown failed", error);
		}
		try {
			this.instance?.unload?.();
		} catch {
			/* the editor may not be a Component in every build */
		}
		this.instance = null;
		this.options.container.empty();
	}
}

/* -------------------------------------------------------------------------- */
/* Plain fallback editor                                                      */
/* -------------------------------------------------------------------------- */

class PlainEditor implements JournalEditor {
	readonly rich = false;
	private textarea: HTMLTextAreaElement;

	constructor(private options: JournalEditorOptions) {
		this.textarea = options.container.createEl("textarea", {
			cls: "journal-plain-editor",
			attr: { placeholder: options.placeholder, spellcheck: "true", rows: "1" },
		});
		this.textarea.value = options.value;
		this.textarea.addEventListener("input", () => {
			this.autoGrow();
			this.options.onChange();
		});
		this.textarea.addEventListener("focus", () => this.options.onFocus());
		this.textarea.addEventListener("blur", () => this.options.onBlur());
		// The element has no layout yet on the frame it is created.
		window.setTimeout(() => this.autoGrow(), 0);
	}

	private autoGrow(): void {
		this.textarea.setCssProps({ "--journal-editor-height": "auto" });
		this.textarea.setCssProps({ "--journal-editor-height": `${this.textarea.scrollHeight}px` });
	}

	getValue(): string {
		return this.textarea.value;
	}

	setValue(value: string): void {
		if (this.textarea.value === value) return;
		this.textarea.value = value;
		this.autoGrow();
	}

	placeCursorAtEnd(): void {
		const end = this.textarea.value.length;
		this.textarea.setSelectionRange(end, end);
	}

	setFile(): void {
		/* nothing to do */
	}

	focus(): void {
		this.textarea.focus();
	}

	hasFocus(): boolean {
		return this.textarea.ownerDocument.activeElement === this.textarea;
	}

	destroy(): void {
		this.textarea.remove();
		this.options.container.empty();
	}
}

export function createJournalEditor(options: JournalEditorOptions, preferRich: boolean): JournalEditor {
	if (preferRich) {
		const Ctor = resolveEditorCtor(options.app);
		if (Ctor) {
			try {
				return new RichEditor(options, Ctor);
			} catch (error) {
				console.warn("Journal View: falling back to the plain editor", error);
				options.container.empty();
			}
		}
	}
	return new PlainEditor(options);
}
