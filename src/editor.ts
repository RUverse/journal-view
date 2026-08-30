import { App, FileView, TFile, WorkspaceLeaf } from "obsidian";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type { FindRange } from "./findText";

export interface JournalEditorOptions {
	app: App;
	leaf: WorkspaceLeaf;
	workspaceEditors: WorkspaceEditorBridge;
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
	/** Replaces the contents; `preserveSelection` is for a clean external update. */
	setValue(value: string, preserveSelection?: boolean): void;
	setFile(file: TFile | null): void;
	focus(): void;
	hasFocus(): boolean;
	destroy(): void;
	/** Moves the cursor to the position nearest the given window coordinates. */
	placeCursor?(x: number, y: number): void;
	/**
	 * Moves the cursor past everything the editor holds. `reveal` also brings
	 * that position on screen, for the cursor the reader is about to type at.
	 */
	placeCursorAtEnd?(reveal?: boolean): void;
	/** Brings the cursor on screen without moving it. */
	revealCursor?(): void;
	/** Withdraws a reveal that was asked for but has not been carried out yet. */
	cancelReveal?(): void;
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
	defaultLineHeight?: number;
	/** CodeMirror's pending "bring the cursor into view" request, if any. */
	viewState?: { scrollTarget?: unknown };
}

/**
 * Lines left clear around a revealed cursor. The pane runs to the bottom of the
 * window, where Obsidian floats its status bar over it, so a cursor scrolled to
 * the very edge is both cramped and liable to sit under that.
 */
const REVEAL_LINES = 4;
/** Used only when the editor cannot say how tall its lines are. */
const FALLBACK_LINE_HEIGHT = 24;
/** Republish after Obsidian's async file read and delayed focus notification. */
const WORKSPACE_CONTENT_DELAY = 50;

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
	onUpdate?: (update: { selectionSet?: boolean }, changed: boolean) => void;
	load?(): void;
	destroy?(): void;
	unload?(): void;
}

interface InternalEditorOwner extends ActiveEditorOwner {
	app: App;
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
	leaf: WorkspaceLeaf;
}

interface WorkspaceEditorHost {
	activeEditor: unknown;
	lastActiveFile?: TFile | null;
	recentFileTracker?: {
		onFileOpen(file: TFile | null, previous: TFile | null): void;
	};
	getActiveFile(): TFile | null;
	trigger(name: string, ...data: unknown[]): void;
}

type WorkspaceEditorUpdate = "claim" | "release" | "file";

/**
 * Bridges journal editors into Obsidian's workspace bookkeeping. The state is
 * owned by one plugin/app instance, while the per-leaf map prevents one journal
 * tab from lending its hidden editor to another.
 */
export class WorkspaceEditorBridge {
	private readonly journalLeaves = new WeakSet<WorkspaceLeaf>();
	private readonly activeByLeaf = new WeakMap<WorkspaceLeaf, ActiveEditorOwner>();
	private lastActive: ActiveEditorOwner | null = null;

	constructor(private readonly app: App) {}

	registerJournalLeaf(leaf: WorkspaceLeaf): () => void {
		this.journalLeaves.add(leaf);
		return () => {
			this.journalLeaves.delete(leaf);
			const owner = this.activeByLeaf.get(leaf);
			this.activeByLeaf.delete(leaf);
			if (this.lastActive === owner) this.lastActive = null;
		};
	}

	/**
	 * Restores the last day while a non-file pane is active. Journal tabs restore
	 * their own day; real files keep Obsidian's native editor; deferred leaves are
	 * left alone until their eventual view type is knowable.
	 */
	onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		try {
			if (leaf?.isDeferred) return;
			if (leaf?.view instanceof FileView) {
				this.lastActive = null;
				return;
			}

			let owner = this.lastActive;
			if (leaf && this.journalLeaves.has(leaf)) {
				owner = this.activeByLeaf.get(leaf) ?? null;
				this.lastActive = owner;
			}
			if (!owner) return;

			const workspace = this.app.workspace as unknown as WorkspaceEditorHost;
			if (!workspace.activeEditor) workspace.activeEditor = owner;
		} catch (error) {
			console.warn("Journal View: failed to keep workspace.activeEditor", error);
		}
	}

	update(owner: ActiveEditorOwner, update: WorkspaceEditorUpdate, notifyRelease = false): void {
		try {
			const workspace = this.app.workspace as unknown as WorkspaceEditorHost;
			if (update === "claim") {
				// The embedded editor itself may have assigned this owner before its
				// focus event bubbles to us; it does not emit the file notification.
				workspace.activeEditor = owner;
				this.activeByLeaf.set(owner.leaf, owner);
				this.lastActive = owner;
				notifyFileOpen(workspace, owner.file);
			} else if (update === "release") {
				if (notifyRelease) {
					if (this.activeByLeaf.get(owner.leaf) === owner) this.activeByLeaf.delete(owner.leaf);
					if (this.lastActive === owner) this.lastActive = null;
				}
				const owned = workspace.activeEditor === owner;
				if (owned) workspace.activeEditor = null;
				else if (workspace.activeEditor !== null) return;
				// A view owns many mounted editors. Only the one the workspace still
				// considers current should clear file followers during bulk teardown.
				if (notifyRelease && (owned || workspace.getActiveFile() === owner.file)) {
					notifyFileOpen(workspace, null);
				}
			} else if (update === "file" && workspace.activeEditor === owner) {
				notifyFileOpen(workspace, owner.file);
			}
		} catch (error) {
			console.warn("Journal View: could not update the workspace editor", error);
		}
	}
}

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
function notifyFileOpen(workspace: WorkspaceEditorHost, file: TFile | null): void {
	if ("lastActiveFile" in workspace) {
		const previous = workspace.lastActiveFile ?? null;
		if (previous !== file) {
			try {
				// Obsidian normally records the file being left immediately before it
				// updates lastActiveFile. A manual notification must preserve that step.
				workspace.recentFileTracker?.onFileOpen(file, previous);
			} catch (error) {
				console.warn("Journal View: could not preserve recent-file tracking", error);
			}
		}
		workspace.lastActiveFile = file;
	}
	workspace.trigger("file-open", file);
}

/**
 * Publishes the focused editor's in-memory text through the same workspace
 * event as a native Markdown view. Core consumers such as Word Count use this
 * instead of `editor-change`, because the vault can still hold an older value
 * while the editor is being changed.
 */
function publishWorkspaceContent(app: App, owner: ActiveEditorOwner, content: string): void {
	try {
		const workspace = app.workspace as unknown as WorkspaceEditorHost;
		if (owner.file && workspace.activeEditor === owner) {
			workspace.trigger("quick-preview", owner.file, content);
		}
	} catch (error) {
		console.warn("Journal View: could not publish the active editor content", error);
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
	private workspaceContentTimer = 0;
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
			leaf: options.leaf,
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
		instance.onUpdate = (update, changed) => {
			original?.call(instance, update, changed);
			// Obsidian's selection event falls back to the active file view when
			// the selection is empty. A journal is not a file view, so republish
			// this day's text after both edits and collapsed-cursor moves. Leave a
			// real selection alone: Word Count intentionally reports its count.
			if (changed || update.selectionSet) this.scheduleWorkspaceContent();
			if (changed) this.options.onChange();
		};

		// The editor is normally added as a child of Obsidian's MarkdownEmbed,
		// which loads it before assigning content. Constructing it directly skips
		// that lifecycle unless we do it here. In particular, live-preview embeds
		// only register their metadata-change listeners once their component tree
		// is loaded.
		instance.load?.();
		this.instance.set?.(options.value, true);
		this.dropScrollRequest();
		this.reportInitialLayout();

		this.focusIn = (event) => {
			if (focusStayedInside(options.container, event)) return;
			this.options.workspaceEditors.update(this.owner, "claim");
			this.scheduleWorkspaceContent();
			this.options.onFocus();
		};
		this.focusOut = (event) => {
			if (focusStayedInside(options.container, event)) return;
			this.cancelWorkspaceContent();
			this.options.workspaceEditors.update(this.owner, "release");
			this.options.onBlur();
		};
		options.container.addEventListener("focusin", this.focusIn);
		options.container.addEventListener("focusout", this.focusOut);
	}

	/**
	 * Publishes now, then once more after the file-open read and focus events
	 * normally settle. A real selection keeps Obsidian's selection count.
	 */
	private scheduleWorkspaceContent(): void {
		this.cancelWorkspaceContent();
		if (this.owner.getSelection()) return;
		this.publishCurrentContent();
		this.workspaceContentTimer = window.setTimeout(() => {
			this.workspaceContentTimer = 0;
			if (!this.destroyed) this.publishCurrentContent();
		}, WORKSPACE_CONTENT_DELAY);
	}

	/** A failed internal read must not masquerade as an empty note. */
	private publishCurrentContent(): void {
		const content = this.readValue();
		if (content !== null) publishWorkspaceContent(this.options.app, this.owner, content);
	}

	private cancelWorkspaceContent(): void {
		if (this.workspaceContentTimer) window.clearTimeout(this.workspaceContentTimer);
		this.workspaceContentTimer = 0;
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

	private readValue(): string | null {
		try {
			if (typeof this.instance?.get === "function") return this.instance.get() ?? "";
			return this.instance?.editor?.getValue?.() ?? "";
		} catch (error) {
			console.warn("Journal View: could not read editor contents", error);
			return null;
		}
	}

	getValue(): string {
		return this.readValue() ?? "";
	}

	setValue(value: string, preserveSelection = false): void {
		try {
			// Obsidian's non-clearing path applies the smallest document change,
			// mapping the selection through it. Template offers retain the clearing
			// behavior they have always used; only external updates ask to preserve.
			this.instance?.set?.(value, !preserveSelection);
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
		this.options.workspaceEditors.update(this.owner, "file");
		this.scheduleWorkspaceContent();
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

	placeCursorAtEnd(reveal = false): void {
		try {
			this.instance?.editor?.cm?.dispatch?.({ selection: { anchor: this.getValue().length } });
			// A cursor the reader is meant to carry on typing at is worth the
			// scroll; one placed under them - a template offer - is not.
			if (reveal) this.revealCursor();
			else this.dropScrollRequest();
		} catch {
			/* the cursor stays wherever focus put it */
		}
	}

	revealCursor(): void {
		try {
			const cm = this.instance?.editor?.cm;
			const head = cm?.state?.selection.main.head;
			if (!cm?.dispatch || typeof head !== "number") return;
			cm.dispatch({
				effects: EditorView.scrollIntoView(head, {
					y: "nearest",
					yMargin: (cm.defaultLineHeight ?? FALLBACK_LINE_HEIGHT) * REVEAL_LINES,
				}),
			});
		} catch {
			/* the view keeps whatever position it already had */
		}
	}

	/**
	 * A reveal is carried out in a later measure pass, so the last one asked for
	 * can still be in flight when the reader takes the journal over. Dropping it
	 * is the same withdrawal a newly built editor makes.
	 */
	cancelReveal(): void {
		this.dropScrollRequest();
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
		this.cancelWorkspaceContent();
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
		this.options.workspaceEditors.update(this.owner, "release", true);
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

	setValue(value: string, preserveSelection = false): void {
		if (this.textarea.value === value) return;
		const selectionStart = this.textarea.selectionStart;
		const selectionEnd = this.textarea.selectionEnd;
		this.textarea.value = value;
		if (preserveSelection && this.hasFocus()) {
			this.textarea.setSelectionRange(selectionStart, selectionEnd);
		}
		this.autoGrow();
	}

	placeCursorAtEnd(reveal = false): void {
		const end = this.textarea.value.length;
		this.textarea.setSelectionRange(end, end);
		if (reveal) this.revealCursor();
	}

	/**
	 * The textarea grows to its full content and never scrolls itself, so its
	 * bottom edge is where a cursor at the end sits. Anywhere else in the text
	 * has no box of its own to bring on screen, and is left alone.
	 */
	revealCursor(): void {
		const end = this.textarea.value.length;
		if (this.textarea.selectionStart !== end || this.textarea.selectionEnd !== end) return;
		this.textarea.scrollIntoView({ block: "end" });
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
