import { App, TFile } from "obsidian";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type { FindRange } from "./findText";

export interface JournalEditorOptions {
	app: App;
	container: HTMLElement;
	value: string;
	placeholder: string;
	/** The note being edited, when it already exists. Used for link resolution. */
	file: TFile | null;
	onChange: () => void;
	/** Called after the editor has completed its first real layout pass. */
	onReady: () => void;
	onFocus: () => void;
	onBlur: () => void;
	onFind: () => void;
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
	/** Draws every loaded match and distinguishes the selected range. */
	setFindMatches(ranges: FindRange[], selected: FindRange | null): void;
	clearFindMatches(): void;
	/** Reveals a range without taking focus from the find input. */
	revealRange(range: FindRange): void;
}

/* -------------------------------------------------------------------------- */
/* Obsidian's own markdown editor                                             */
/* -------------------------------------------------------------------------- */

interface InternalCodeMirror {
	posAtCoords?(coords: { x: number; y: number }, precise: boolean): number | null;
	dispatch?(spec: TransactionSpec): void;
	requestMeasure?(request: { read: () => null; write: () => void }): void;
	state?: EditorState;
	/** CodeMirror's pending "bring the cursor into view" request, if any. */
	viewState?: { scrollTarget?: unknown };
}

const setFindDecorations = StateEffect.define<DecorationSet>();
const findDecorations = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, transaction) {
		let next = value.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (effect.is(setFindDecorations)) next = effect.value;
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field),
});

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
	onUpdate?: (update: unknown, changed: boolean) => void;
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
	showSearch(): void;
	toggleMode(): undefined;
	editor?: InternalEditorApi;
	editMode?: InternalEditorInstance;
}

interface ActiveEditorOwner {
	file: TFile | null;
}

type WorkspaceEditorUpdate = "claim" | "release" | "file";

function focusStayedInside(container: HTMLElement, event: FocusEvent): boolean {
	const NodeCtor = container.ownerDocument.defaultView?.Node;
	return !!NodeCtor && event.relatedTarget instanceof NodeCtor && container.contains(event.relatedTarget);
}

/**
 * Obsidian's file-oriented side panes follow the `file-open` event, including
 * when a native embedded editor (such as a Canvas card) receives focus. Merely
 * assigning `activeEditor` is enough for editor commands and `getActiveFile`,
 * but does not tell Outline, Backlinks, or Properties to follow it.
 */
function updateWorkspaceEditor(
	app: App,
	owner: ActiveEditorOwner,
	update: WorkspaceEditorUpdate,
	notifyRelease = false,
): void {
	try {
		const workspace = app.workspace as unknown as {
			activeEditor: unknown;
			getActiveFile(): TFile | null;
			trigger(name: string, ...data: unknown[]): void;
		};
		if (update === "claim") {
			// The embedded editor itself may have assigned this owner before its
			// focus event bubbles to us; it does not emit the file notification.
			workspace.activeEditor = owner;
			workspace.trigger("file-open", owner.file);
		} else if (update === "release") {
			const owned = workspace.activeEditor === owner;
			if (owned) workspace.activeEditor = null;
			else if (workspace.activeEditor !== null) return;
			// A view owns many mounted editors. Only the one the workspace still
			// considers current should clear file followers during bulk teardown.
			if (notifyRelease && (owned || workspace.getActiveFile() === owner.file)) {
				workspace.trigger("file-open", null);
			}
		} else if (update === "file" && workspace.activeEditor === owner) {
			workspace.trigger("file-open", owner.file);
		}
	} catch (error) {
		console.warn("Journal View: could not update the workspace editor", error);
	}
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
			const parent: unknown = Object.getPrototypeOf(editMode);
			const proto: unknown = parent && typeof parent === "object" ? Object.getPrototypeOf(parent) : null;
			if (proto && typeof proto === "object") {
				const ctor: unknown = (proto as Record<string, unknown>).constructor;
				if (typeof ctor === "function") cachedCtor = ctor as EditorCtor;
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
	private focusIn: (event: FocusEvent) => void;
	private focusOut: (event: FocusEvent) => void;
	private readyFrame = 0;
	private readyReported = false;
	private destroyed = false;

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
			showSearch: () => this.options.onFind(),
			toggleMode: () => undefined,
		};

		this.instance = new Ctor(options.app, options.container, this.owner);

		// Makes the owner usable as a MarkdownFileInfo, so Obsidian's editor
		// commands (bold, link, templates, ...) can target this day.
		Object.defineProperty(this.owner, "editor", {
			configurable: true,
			get: () => this.instance?.editor,
		});
		// File-following core panes treat an active embedded editor like Canvas's
		// MarkdownEmbed and read its edit mode to decide how to build live state.
		Object.defineProperty(this.owner, "editMode", {
			configurable: true,
			get: () => this.instance ?? undefined,
		});

		const instance = this.instance;
		const original = instance.onUpdate;
		instance.onUpdate = (update: unknown, changed: boolean) => {
			original?.call(instance, update, changed);
			if (changed) this.options.onChange();
		};

		this.instance.set?.(options.value, true);
		this.dropScrollRequest();
		this.reportInitialLayout();

		this.focusIn = (event) => {
			if (focusStayedInside(options.container, event)) return;
			updateWorkspaceEditor(this.options.app, this.owner, "claim");
			this.options.onFocus();
		};
		this.focusOut = (event) => {
			if (focusStayedInside(options.container, event)) return;
			updateWorkspaceEditor(this.options.app, this.owner, "release");
			this.options.onBlur();
		};
		options.container.addEventListener("focusin", this.focusIn);
		options.container.addEventListener("focusout", this.focusOut);
	}

	/** Releases the preview-height guard only after CodeMirror has measured its DOM. */
	private reportInitialLayout(): void {
		try {
			const cm = this.instance?.editor?.cm;
			if (cm?.requestMeasure) {
				cm.requestMeasure({ read: () => null, write: () => this.reportReady() });
				return;
			}
		} catch {
			/* fall through to a frame when the internal measurement API is unavailable */
		}
		this.readyFrame = window.requestAnimationFrame(() => {
			this.readyFrame = 0;
			this.reportReady();
		});
	}

	private reportReady(): void {
		if (this.destroyed || this.readyReported) return;
		this.readyReported = true;
		this.options.onReady();
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
		updateWorkspaceEditor(this.options.app, this.owner, "file");
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

	setFindMatches(ranges: FindRange[], selected: FindRange | null): void {
		try {
			const cm = this.instance?.editor?.cm;
			const state = cm?.state;
			if (!cm?.dispatch || !state) return;
			if (!state.field(findDecorations, false)) {
				cm.dispatch({ effects: StateEffect.appendConfig.of(findDecorations) });
			}
			const length = cm.state?.doc.length ?? this.getValue().length;
			const marks = ranges
				.filter((range) => range.from < range.to && range.from < length)
				.map((range) => {
					const active = selected && range.from === selected.from && range.to === selected.to;
					return Decoration.mark({
						class: active ? "journal-find-match journal-find-match-selected" : "journal-find-match",
					}).range(range.from, Math.min(range.to, length));
				});
			cm.dispatch({ effects: setFindDecorations.of(Decoration.set(marks, true)) });
		} catch (error) {
			console.warn("Journal View: could not highlight find results", error);
		}
	}

	clearFindMatches(): void {
		try {
			const cm = this.instance?.editor?.cm;
			if (cm?.state?.field(findDecorations, false)) {
				cm.dispatch?.({ effects: setFindDecorations.of(Decoration.none) });
			}
		} catch {
			/* search highlighting is optional; the editor remains usable */
		}
	}

	revealRange(range: FindRange): void {
		try {
			const cm = this.instance?.editor?.cm;
			const length = cm?.state?.doc.length ?? this.getValue().length;
			const from = Math.max(0, Math.min(range.from, length));
			const to = Math.max(from, Math.min(range.to, length));
			cm?.dispatch?.({
				selection: { anchor: from, head: to },
				effects: EditorView.scrollIntoView(from, { y: "center" }),
			});
		} catch (error) {
			console.warn("Journal View: could not reveal find result", error);
		}
	}

	hasFocus(): boolean {
		const active = this.options.container.ownerDocument.activeElement;
		return !!active && this.options.container.contains(active);
	}

	destroy(): void {
		this.destroyed = true;
		if (this.readyFrame) window.cancelAnimationFrame(this.readyFrame);
		this.readyFrame = 0;
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
		// A blur deliberately leaves file-following panes on the last edited day.
		// Teardown runs after the internal editor has finished its own focus work,
		// then clears the owner unless another editor claimed the workspace.
		updateWorkspaceEditor(this.options.app, this.owner, "release", true);
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
	private findLayer: HTMLElement | null = null;
	private readyTimer = 0;

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
		this.readyTimer = window.setTimeout(() => {
			this.readyTimer = 0;
			this.autoGrow();
			this.options.onReady();
		}, 0);
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

	setFindMatches(ranges: FindRange[], selected: FindRange | null): void {
		this.clearFindMatches();
		if (!ranges.length) return;
		this.textarea.addClass("journal-plain-editor-find-active");
		this.findLayer = this.options.container.createDiv({
			cls: "journal-plain-find-layer",
			attr: { "aria-hidden": "true" },
		});
		const value = this.textarea.value;
		let cursor = 0;
		for (const range of ranges) {
			const from = Math.max(cursor, Math.min(range.from, value.length));
			const to = Math.max(from, Math.min(range.to, value.length));
			if (from > cursor) this.findLayer.appendText(value.slice(cursor, from));
			const mark = this.findLayer.createEl("mark", {
				cls:
					selected && selected.from === range.from && selected.to === range.to
						? "journal-find-match journal-find-match-selected"
						: "journal-find-match",
				text: value.slice(from, to),
			});
			mark.dataset.from = String(range.from);
			cursor = to;
		}
		if (cursor < value.length) this.findLayer.appendText(value.slice(cursor));
		// Preserve the final empty line in the mirror's layout.
		if (value.endsWith("\n")) this.findLayer.appendText("\u200b");
	}

	clearFindMatches(): void {
		this.findLayer?.remove();
		this.findLayer = null;
		this.textarea.removeClass("journal-plain-editor-find-active");
	}

	revealRange(range: FindRange): void {
		const from = Math.max(0, Math.min(range.from, this.textarea.value.length));
		const to = Math.max(from, Math.min(range.to, this.textarea.value.length));
		this.textarea.setSelectionRange(from, to);
		const selected = this.findLayer?.querySelector<HTMLElement>(
			`.journal-find-match-selected[data-from="${range.from}"]`,
		);
		selected?.scrollIntoView({ block: "center" });
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
		window.clearTimeout(this.readyTimer);
		this.readyTimer = 0;
		this.clearFindMatches();
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
