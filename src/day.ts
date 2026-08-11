import { App, Component, MarkdownRenderer, Notice, TFile, getFrontMatterInfo, setIcon, setTooltip } from "obsidian";
import type JournalViewPlugin from "./main";
import { JournalEditor, createJournalEditor } from "./editor";
import type { Moment } from "./moment";
import { SaveQueue } from "./saveQueue";
import { findLiteralRanges } from "./findText";
import type { FindRange } from "./findText";

/**
 * Frames a cursor placed at the end of a day is kept on screen for, long
 * enough to outlast the centring and the rebuild that can follow a go-to.
 */
const REVEAL_FRAMES = 10;
/** The reader moving the journal themselves, which ends that hold at once. */
const READER_SCROLL_EVENTS = ["wheel", "touchmove", "pointerdown"] as const;
const REVEAL_LISTENER: AddEventListenerOptions = { capture: true, passive: true };

/** The bits of the journal view a day needs to talk to. */
export interface DayHost {
	app: App;
	plugin: JournalViewPlugin;
	/** Called when a day's underlying file appears, disappears or is renamed. */
	onDayFileChanged(day: DaySection, previousPath: string | null): void;
	/** True for a day that stays in the journal even with empty days hidden. */
	isPinnedDay(day: DaySection): boolean;
	/** True while a day is out of sight, where its body can be swapped unseen. */
	isOffScreen(day: DaySection): boolean;
	/** Re-indexes find results after this day's visible body changes. */
	onDayContentChanged(day: DaySection): void;
	/** Re-centres a navigation after focus-driven editor and template layout settles. */
	onDayFocusSettled(day: DaySection): void;
	/** Opens the journal-wide find UI from an embedded editor command. */
	showFind(): void;
}

/**
 * The journal edits only the note body. Obsidian's parser locates frontmatter
 * so it can be preserved exactly rather than parsed and serialized again.
 */
function noteBody(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
}

/** CodeMirror stores every line break as `\n`, regardless of the file's EOL. */
function editorBody(content: string): string {
	return noteBody(content).replace(/\r\n?/g, "\n");
}

function replaceNoteBody(content: string, body: string): string {
	return content.slice(0, getFrontMatterInfo(content).contentStart) + body;
}

function sameFindRange(left: FindRange | null, right: FindRange | null): boolean {
	return left === right || (!!left && !!right && left.from === right.from && left.to === right.to);
}

function sameFindRanges(left: FindRange[], right: FindRange[]): boolean {
	return (
		left.length === right.length &&
		left.every((range, index) => range.from === right[index].from && range.to === right[index].to)
	);
}

/**
 * One day in the journal. A day has two modes:
 *
 * - Edit: a real editor. Every day the reader can see is in this mode, so
 *   clicking into text only moves the cursor - nothing is swapped out from
 *   under the click and nothing reflows.
 * - Preview: the note rendered as static markdown, used for days that are far
 *   enough off screen that keeping an editor alive for them is waste. Static
 *   DOM costs nothing to keep and is laid out at its true height.
 *
 * The view decides which mode a day is in (see `EditorWindow.update`) and
 * only ever changes it while the day is well outside the viewport, so a mode
 * change is never something the reader can watch happen.
 */
export class DaySection {
	readonly el: HTMLElement;
	readonly key: string;

	private yearEl: HTMLElement;
	private monthEl: HTMLElement;
	private cardEl: HTMLElement;
	private headerEl: HTMLElement;
	private titleEl: HTMLElement;
	private actionsEl: HTMLElement;
	private bodyEl: HTMLElement;

	private editor: JournalEditor | null = null;
	private previewComponent: Component | null = null;
	private destroyed = false;
	/**
	 * Bumped whenever the day's mode is asked to change. A preview is built
	 * asynchronously, so the token tells a finished build whether the mode it
	 * was rendered for is still the one wanted.
	 */
	private modeToken = 0;
	/** True while a preview is being built to replace this day's editor. */
	private unmounting = false;
	/** Preview height (px) held until the editor completes its first layout. */
	private heldHeight = 0;
	/** Pending frame of the run that keeps a cursor placed at the end in view. */
	private revealFrame = 0;
	/** Drops the listeners watching for the reader to take that run over. */
	private endReveal: (() => void) | null = null;

	private lastKnownContent = "";
	/** An external write held off until this day's own pending edit has settled. */
	private externalReloadPending = false;
	/** Template text shown in an empty day but not yet accepted by the reader. */
	private pendingTemplate: string | null = null;
	private saveTimer = 0;
	private focused = false;
	/** Invalidates focus-settle work when focus leaves or the day is destroyed. */
	private focusSettleToken = 0;
	private readonly queue = new SaveQueue((value) => this.writeValue(value));
	private findState: {
		query: string;
		caseSensitive: boolean;
		ranges: FindRange[];
		selected: FindRange | null;
	} | null = null;

	file: TFile | null;
	path: string;

	constructor(
		private host: DayHost,
		readonly date: Moment,
		readonly offset: number,
	) {
		this.key = date.format("YYYY-MM-DD");
		this.path = host.plugin.daily.pathFor(date);
		this.file = host.plugin.daily.fileFor(date);

		this.el = createDiv({ cls: "journal-day", attr: { "data-date": this.key } });
		this.yearEl = this.el.createDiv({
			cls: "journal-year-separator",
			text: date.format("YYYY"),
			attr: { role: "heading", "aria-level": "2" },
		});
		this.yearEl.hidden = true;
		this.monthEl = this.el.createDiv({
			cls: "journal-month-separator",
			attr: { role: "heading", "aria-level": "3" },
		});
		this.monthEl.createSpan({ cls: "journal-month-name", text: date.format("MMMM") });
		this.monthEl.createSpan({ cls: "journal-month-year", text: date.format("YYYY") });
		this.monthEl.hidden = true;
		this.cardEl = this.el.createDiv({ cls: "journal-day-card" });
		this.headerEl = this.cardEl.createDiv({ cls: "journal-day-header" });
		this.titleEl = this.headerEl.createDiv({ cls: "journal-day-title" });
		this.titleEl.createSpan({ cls: "journal-day-date", text: this.formatHeader() });
		const relative = this.relativeLabel();
		if (relative) this.titleEl.createSpan({ cls: "journal-day-badge", text: relative });
		this.actionsEl = this.headerEl.createDiv({ cls: "journal-day-actions" });

		this.bodyEl = this.cardEl.createDiv({ cls: "journal-day-body" });

		this.el.addEventListener("click", (event) => this.onClick(event));

		this.refreshState();
	}

	private onClick(event: MouseEvent): void {
		const target = event.target as HTMLElement;
		if (target.closest(".journal-day-actions")) return;

		if (this.editor) {
			// The editor handles clicks that land in its own text, links
			// included. A click on the day's padding does not reach it, so
			// place the cursor at the nearest position by hand.
			if (this.editor.hasFocus() || !target.closest(".journal-day-body")) return;
			if (window.getSelection()?.toString()) return;
			this.focusAt(event);
			return;
		}

		// The rest only applies to days far enough off screen to still be a
		// preview - the reader has to arrive there faster than the view can
		// mount an editor, so it is rare but has to keep working.

		// Links in the preview navigate; they should not start an edit.
		const link = target.closest("a");
		if (link) {
			event.preventDefault();
			const href = link.getAttribute("data-href") ?? link.getAttribute("href");
			if (!href) return;
			if (link.classList.contains("internal-link")) {
				void this.host.app.workspace.openLinkText(href, this.path, event.ctrlKey || event.metaKey);
			} else if (/^https?:/.test(href)) {
				window.open(href);
			}
			return;
		}

		if (!target.closest(".journal-day-body")) return;
		// A click that ends a text selection is a copy gesture, not an edit.
		if (window.getSelection()?.toString()) return;
		this.focusAt(event);
	}

	/** Puts the cursor where the day was clicked, mounting an editor if needed. */
	private focusAt(event: MouseEvent): void {
		this.mountEditor();
		const editor = this.editor;
		if (!editor) return;
		editor.focus();
		editor.placeCursor?.(event.clientX, event.clientY);
	}

	/**
	 * Lays the configured template into a day that has no note yet, so the
	 * reader writes into the same skeleton the "Create note" button would have
	 * produced. Driven by focus, so it happens when the reader enters the day
	 * themselves - the view mounts editors ahead of them, and those are left
	 * alone until one is entered.
	 *
	 * The text is an offer, not content: `pendingTemplate` keeps it out of the
	 * save queue until the reader edits it, so clicking through an empty day
	 * still leaves nothing behind in the vault.
	 */
	private async offerTemplate(): Promise<void> {
		if (this.file || !this.editor || this.editor.getValue().length > 0) return;
		const body = editorBody(await this.host.plugin.daily.templateContent(this.date));
		// Reading the template yields, so everything above is re-checked: the
		// reader may have typed, left, or the note may have appeared, in
		// between. An offer landing after they left would have nothing to
		// withdraw it.
		if (!body || this.destroyed || !this.hasFocus) return;
		if (this.file || !this.editor || this.editor.getValue().length > 0) return;

		// Set first: filling the editor reports a change, and the save that
		// follows has to already know the text is only an offer.
		this.pendingTemplate = body;
		this.editor.setValue(body);
		this.editor.placeCursorAtEnd?.();
		this.releaseHeight();
		this.updateBlankState();
	}

	/** Takes back an untouched template offer, leaving the day empty again. */
	private withdrawTemplate(): boolean {
		const pending = this.pendingTemplate;
		if (pending === null) return false;
		if (!this.editor || this.editor.getValue() !== pending) {
			// The reader made it their own; it saves like anything they wrote.
			this.pendingTemplate = null;
			return false;
		}

		this.pendingTemplate = null;
		this.editor.setValue(editorBody(this.lastKnownContent));
		this.updateBlankState();
		// A note can appear between offering the template and this blur. Re-read
		// it rather than leave the pre-offer content in the editor.
		if (this.file) void this.reload();
		return true;
	}

	/* ---------------------------------------------------------------- state */

	get isToday(): boolean {
		return this.offset === 0;
	}

	get exists(): boolean {
		return this.file !== null;
	}

	/** True while this day holds a live editor rather than a static preview. */
	get isEditing(): boolean {
		return this.editor !== null;
	}

	/** False for a day the layout is ignoring, e.g. a hidden empty day. */
	get isLaidOut(): boolean {
		return this.el.offsetParent !== null;
	}

	/** Viewport position of stable day content, below any movable date headings. */
	get contentTop(): number {
		return this.headerEl.getBoundingClientRect().top;
	}

	/** Card geometry excludes the optional year and month headings above the day. */
	get cardTop(): number {
		return this.el.offsetTop + this.cardEl.offsetTop;
	}

	get cardHeight(): number {
		return this.cardEl.offsetHeight;
	}

	/** True when the day itself is filtered out, independent of pane visibility. */
	get isHidden(): boolean {
		return this.el.hasClass("journal-day-hidden");
	}

	/** Shows the month heading carried by the first rendered day in that month. */
	setMonthSeparator(visible: boolean): void {
		this.monthEl.hidden = !visible;
	}

	/** Shows the year heading when this day follows a rendered day in another year. */
	setYearSeparator(visible: boolean): void {
		this.yearEl.hidden = !visible;
		this.el.toggleClass("journal-day-year-start", visible);
	}

	private formatHeader(): string {
		return this.date.format(this.host.plugin.settings.headerFormat);
	}

	private relativeLabel(): string | null {
		return this.offset === 0 ? "Today" : null;
	}

	/** Re-applies the classes and header buttons that depend on the file. */
	refreshState(): void {
		this.el.toggleClass("journal-day-today", this.isToday);
		this.el.toggleClass("journal-day-empty", !this.exists);
		this.el.toggleClass("journal-day-future", this.offset > 0);
		this.el.toggleClass(
			"journal-day-hidden",
			!this.exists && !this.host.isPinnedDay(this) && this.host.plugin.settings.hideEmptyDays,
		);

		this.bodyEl.dataset.placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		this.actionsEl.empty();
		setTooltip(this.titleEl, this.path, { placement: "right" });

		if (this.exists) {
			const remove = this.actionsEl.createEl("button", {
				cls: "clickable-icon journal-day-action journal-day-delete",
			});
			setIcon(remove, "trash-2");
			setTooltip(remove, "Delete note");
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.deleteNote();
			});

			const open = this.actionsEl.createEl("button", { cls: "clickable-icon journal-day-action" });
			setIcon(open, "file-text");
			setTooltip(open, "Open note in a tab");
			open.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.openInTab(event.ctrlKey || event.metaKey);
			});
		} else {
			const create = this.actionsEl.createEl("button", {
				cls: "journal-day-action journal-day-create",
				text: "Create note",
			});
			setTooltip(create, `Create ${this.path}`);
			create.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.createNow();
			});
		}
	}

	private async deleteNote(): Promise<void> {
		await this.flush();
		if (this.queue.hasPending) return; // the failed save already showed a notice

		const file = this.file;
		if (!file) return;

		try {
			const fileManager = this.host.app.fileManager;
			if (!(await fileManager.promptForDeletion(file))) return;
			// Honor the user's configured trash destination.
			await fileManager.trashFile(file);
		} catch (error) {
			console.error(`Journal View: could not delete ${file.path}`, error);
			new Notice(`Journal View: could not delete ${file.path}`);
		}
	}

	/** Recomputes the expected path, e.g. after the date format changed. */
	revalidate(): void {
		const path = this.host.plugin.daily.pathFor(this.date);
		const file = this.host.plugin.daily.fileFor(this.date);
		const changed = path !== this.path || file !== this.file;
		this.path = path;
		this.file = file;
		if (changed) {
			this.editor?.setFile(file);
			this.refreshState();
			void this.reload();
		}
	}

	setFile(file: TFile | null): void {
		if (this.file === file) return;
		const previousPath = this.file?.path ?? null;
		this.file = file;
		this.path = file?.path ?? this.host.plugin.daily.pathFor(this.date);
		this.editor?.setFile(file);
		this.refreshState();
		this.host.onDayFileChanged(this, previousPath);
	}

	/* -------------------------------------------------------------- preview */

	get hasFocus(): boolean {
		return this.focused || (this.editor?.hasFocus() ?? false);
	}

	get isDirty(): boolean {
		if (this.queue.hasPending) return true;
		if (!this.editor) return false;
		const value = this.editor.getValue();
		// An untouched template offer is not the reader's work, so it must not
		// pin the day to edit mode or fend off content arriving from the vault.
		if (value === this.pendingTemplate) return false;
		return value !== editorBody(this.lastKnownContent);
	}

	/** The body as the reader sees it, including edits not yet written to disk. */
	searchText(): string {
		return this.editor?.getValue() ?? editorBody(this.lastKnownContent);
	}

	setFindState(
		query: string,
		caseSensitive: boolean,
		ranges: FindRange[],
		selected: FindRange | null,
	): void {
		const current = this.findState;
		if (
			current &&
			current.query === query &&
			current.caseSensitive === caseSensitive &&
			sameFindRanges(current.ranges, ranges)
		) {
			// Loaded-window refreshes first publish ranges without an active
			// result. Preserve the current one until the controller resolves it.
			if (selected !== null && !sameFindRange(current.selected, selected)) {
				current.selected = selected;
				this.applyFindState();
			}
			return;
		}
		this.findState = { query, caseSensitive, ranges, selected };
		this.applyFindState();
	}

	selectFindRange(selected: FindRange | null): void {
		if (!this.findState) return;
		if (sameFindRange(this.findState.selected, selected)) return;
		this.findState.selected = selected;
		this.applyFindState();
	}

	clearFindState(): void {
		this.findState = null;
		this.editor?.clearFindMatches();
		this.clearPreviewFindMarks();
	}

	revealFindRange(range: FindRange): void {
		this.applyFindState();
		this.editor?.revealRange(range);
	}

	/** Reads the day's note; days without a note are simply empty. */
	async readContent(): Promise<string> {
		if (!this.file) return "";
		try {
			return await this.host.app.vault.cachedRead(this.file);
		} catch (error) {
			console.error(`Journal View: could not read ${this.path}`, error);
			return "";
		}
	}

	/**
	 * Reads the note and renders its preview. The view awaits this before the
	 * day enters the DOM, so a day is always inserted at its full height.
	 */
	async prepare(): Promise<void> {
		const content = await this.readContent();
		if (this.destroyed) return;
		this.lastKnownContent = content;
		await this.renderPreview(content);
	}

	/** Renders `content` into a fresh preview container, off-DOM. */
	private async buildPreview(content: string): Promise<{ component: Component; container: HTMLElement } | null> {
		const component = new Component();
		component.load();
		const container = createDiv({ cls: "journal-day-preview markdown-rendered" });
		const body = noteBody(content);
		try {
			await MarkdownRenderer.render(this.host.app, body, container, this.path, component);
		} catch (error) {
			console.error(`Journal View: could not render ${this.path}`, error);
			container.setText(body);
		}
		if (this.destroyed) {
			component.unload();
			return null;
		}
		return { component, container };
	}

	/** Swaps whatever the body holds for `built`, in one synchronous step. */
	private applyPreview(built: { component: Component; container: HTMLElement }, content: string): void {
		this.editor?.destroy();
		this.editor = null;
		this.previewComponent?.unload();
		this.previewComponent = built.component;
		this.bodyEl.empty();
		this.releaseHeight();
		this.el.removeClass("journal-day-editing");
		this.bodyEl.appendChild(built.container);
		this.el.toggleClass("journal-day-blank", noteBody(content).trim().length === 0);
		this.applyFindState();
	}

	private applyFindState(): void {
		const state = this.findState;
		if (!state || !state.query) {
			this.editor?.clearFindMatches();
			this.clearPreviewFindMarks();
			return;
		}
		if (this.editor) {
			this.clearPreviewFindMarks();
			this.editor.setFindMatches(state.ranges, state.selected);
			return;
		}
		this.highlightPreview(state.query, state.caseSensitive);
	}

	/** Highlights rendered preview text without changing Markdown structure. */
	private highlightPreview(query: string, caseSensitive: boolean): void {
		this.clearPreviewFindMarks();
		const preview = this.bodyEl.querySelector<HTMLElement>(".journal-day-preview");
		if (!preview || !query) return;
		const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let node = walker.nextNode();
		while (node) {
			if (node.nodeType === Node.TEXT_NODE && node.nodeValue) nodes.push(node as Text);
			node = walker.nextNode();
		}
		for (const textNode of nodes) {
			const ranges = findLiteralRanges(textNode.data, query, caseSensitive);
			if (!ranges.length || !textNode.parentNode) continue;
			const fragment = createFragment();
			let cursor = 0;
			for (const range of ranges) {
				if (range.from > cursor) fragment.appendText(textNode.data.slice(cursor, range.from));
				fragment.createEl("mark", {
					cls: "journal-find-match",
					text: textNode.data.slice(range.from, range.to),
				});
				cursor = range.to;
			}
			if (cursor < textNode.data.length) fragment.appendText(textNode.data.slice(cursor));
			textNode.replaceWith(fragment);
		}
	}

	private clearPreviewFindMarks(): void {
		const parents = new Set<Node>();
		for (const mark of Array.from(this.bodyEl.querySelectorAll("mark.journal-find-match"))) {
			if (!mark.closest(".journal-day-preview")) continue;
			const parent = mark.parentNode;
			if (parent) parents.add(parent);
			mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
		}
		for (const parent of parents) parent.normalize();
	}

	private async renderPreview(content: string): Promise<void> {
		if (this.destroyed || this.editor) return;
		const token = ++this.modeToken;
		const built = await this.buildPreview(content);
		if (!built) return;
		if (token !== this.modeToken || this.editor) {
			// An editor was mounted while the preview rendered; theirs wins.
			built.component.unload();
			return;
		}
		this.applyPreview(built, content);
	}

	/* -------------------------------------------------------------- editing */

	/**
	 * Swaps the preview for a live editor, without taking focus. The view
	 * mounts editors ahead of the reader, so by the time a day is close enough
	 * to click it is already one.
	 *
	 * The preview height stays in place through the editor's first measurement,
	 * preventing a half-laid-out frame without leaving a stale minimum height
	 * behind for the reader to release with their first click.
	 */
	mountEditor(): void {
		if (this.destroyed || this.editor) return;
		this.modeToken++;
		this.pendingTemplate = null;
		this.heldHeight = this.bodyEl.offsetHeight;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.bodyEl.empty();
		if (this.heldHeight > 0) this.bodyEl.setCssProps({ "--journal-held-height": `${this.heldHeight}px` });
		this.el.addClass("journal-day-editing");
		const body = editorBody(this.lastKnownContent);
		const placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		const token = this.modeToken;
		try {
			this.editor = createJournalEditor(
				{
					app: this.host.app,
					container: this.bodyEl,
					value: body,
					placeholder,
					file: this.file,
					onReady: () => {
						if (this.destroyed || token !== this.modeToken) return;
						this.releaseHeight();
					},
					onChange: () => {
						this.releaseHeight();
						this.updateBlankState();
						this.scheduleSave();
						this.host.onDayContentChanged(this);
					},
					onFocus: () => this.onEditorFocus(),
					onBlur: () => this.onEditorBlur(),
					onFind: () => this.host.showFind(),
				},
				this.host.plugin.settings.richEditor,
			);
		} catch (error) {
			// The day has already given up its preview; put one back rather
			// than leave it blank.
			console.error(`Journal View: could not open an editor for ${this.path}`, error);
			this.el.removeClass("journal-day-editing");
			this.bodyEl.empty();
			void this.renderPreview(this.lastKnownContent);
			return;
		}
		this.updateBlankState();
		this.applyFindState();
	}

	/**
	 * Returns a day to a static preview. Only ever called for days far off
	 * screen, and never for one that is being written in - the preview is
	 * built from the content on disk, so anything unsaved would be lost.
	 */
	async unmountEditor(): Promise<void> {
		if (this.destroyed || !this.editor || this.unmounting) return;
		if (this.hasFocus || this.isDirty) return;
		const content = this.lastKnownContent;
		const token = ++this.modeToken;
		this.unmounting = true;
		try {
			// Built while the editor still stands, then swapped in one step, so
			// the day never spends a frame at zero height.
			const built = await this.buildPreview(content);
			if (!built) return;
			// Rendering takes long enough for the day to have been scrolled back
			// into sight, or for the note to have changed under it. Either way
			// this preview is not the one to show; the day stays an editor and
			// the view asks again when it is out of sight.
			const stale =
				token !== this.modeToken ||
				this.hasFocus ||
				this.lastKnownContent !== content ||
				!this.host.isOffScreen(this);
			if (stale) {
				built.component.unload();
				return;
			}
			this.applyPreview(built, content);
		} finally {
			this.unmounting = false;
		}
	}

	/** Lets the day's height follow the editor again. */
	private releaseHeight(): void {
		if (this.heldHeight === 0) return;
		this.heldHeight = 0;
		this.bodyEl.setCssProps({ "--journal-held-height": "0px" });
	}

	private onEditorFocus(): void {
		this.focused = true;
		// Measurement should normally have released the guard before the
		// reader arrives; focus is the defensive fallback.
		this.releaseHeight();
		this.el.addClass("journal-day-focused");
		// Focus is the one signal every way in shares - a click the editor
		// swallowed, a keyboard tab, or a jump to a date.
		const token = ++this.focusSettleToken;
		void this.reportFocusSettled(token);
	}

	/** Waits through template insertion and the editor's resulting measurements. */
	private async reportFocusSettled(token: number): Promise<void> {
		await this.offerTemplate();
		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		if (this.destroyed || token !== this.focusSettleToken || !this.hasFocus) return;
		this.host.onDayFocusSettled(this);
	}

	/** Blurring an editor is not leaving the day, but it is a good time to save. */
	private onEditorBlur(): void {
		this.focusSettleToken++;
		this.focused = false;
		this.el.removeClass("journal-day-focused");
		// Leaving a day the reader only looked at costs them nothing.
		if (this.withdrawTemplate()) return;
		void this.flush();
	}

	/**
	 * The rich editor has no placeholder of its own, so the empty-state hint is
	 * drawn by the stylesheet whenever this class is present.
	 */
	private updateBlankState(): void {
		const blank = !!this.editor && this.editor.rich && this.editor.getValue().length === 0;
		this.el.toggleClass("journal-day-blank", blank);
	}

	/**
	 * Puts the reader in the day's editor. `atEnd` puts the cursor past
	 * everything the day already holds, which is where writing carries on -
	 * asked for by the two ways of arriving at today, opening the journal on it
	 * and coming home to it. Every other way in leaves the cursor where focus
	 * put it: a day reached by date is one to read as much as to write in, and
	 * find needs the cursor on the match it just revealed.
	 */
	focusEditor(atEnd = false): void {
		this.mountEditor();
		if (!this.editor) return;
		this.editor.focus();
		if (!atEnd) return;
		this.editor.placeCursorAtEnd?.(true);
		this.keepCursorInView();
	}

	/**
	 * Holds a cursor placed at the end on screen over the frames that follow.
	 *
	 * Arriving at a day is the view's own scroll: it centres the day, releases
	 * the height its preview was held at, and on a go-to may have rebuilt the
	 * window first. Any of that lands after the editor works out where its
	 * cursor should be scrolled to, and overwrites it - on a long note that
	 * leaves the reader looking at the top of a day whose cursor is at the
	 * bottom. Asking again over the following frames outlives the positioning.
	 *
	 * None of that is worth a single frame of holding the journal against the
	 * reader, so their first move on it ends the run: a wheel, a touch drag or
	 * a pointer in the scroller - a scrollbar drag, or a click that puts the
	 * cursor somewhere they chose - and the view stays where they put it.
	 */
	private keepCursorInView(): void {
		this.stopRevealing();
		const scroller: EventTarget = this.el.closest(".journal-scroll") ?? this.el.ownerDocument;
		const surrender = (): void => this.stopRevealing(true);
		for (const type of READER_SCROLL_EVENTS) scroller.addEventListener(type, surrender, REVEAL_LISTENER);
		this.endReveal = () => {
			for (const type of READER_SCROLL_EVENTS) scroller.removeEventListener(type, surrender, REVEAL_LISTENER);
		};

		let frames = REVEAL_FRAMES;
		const step = (): void => {
			this.revealFrame = 0;
			if (this.destroyed || !this.editor?.hasFocus() || --frames < 0) {
				this.stopRevealing();
				return;
			}
			this.editor.revealCursor?.();
			this.revealFrame = window.requestAnimationFrame(step);
		};
		this.revealFrame = window.requestAnimationFrame(step);
	}

	/**
	 * Ends a reveal run, whether it ran out of frames or the reader took over.
	 * `withdraw` also takes back the reveal the last frame asked for, which is
	 * carried out a frame later and would otherwise undo their scroll once.
	 */
	private stopRevealing(withdraw = false): void {
		window.cancelAnimationFrame(this.revealFrame);
		this.revealFrame = 0;
		this.endReveal?.();
		this.endReveal = null;
		if (withdraw) this.editor?.cancelReveal?.();
	}

	/** Applies a change that happened outside the journal (sync, another tab). */
	applyExternalContent(content: string): void {
		if (!this.editor) {
			this.lastKnownContent = content;
			this.externalReloadPending = false;
			this.host.onDayContentChanged(this);
			return;
		}
		const body = editorBody(content);
		if (this.editor.getValue() === body) {
			this.lastKnownContent = content;
			this.externalReloadPending = false;
			return;
		}
		if (this.isDirty) {
			// A metadata event held off by our pending save is not replayed. Retry
			// once the queue settles so the editor reflects whichever write won.
			this.externalReloadPending = true;
			return;
		}

		this.pendingTemplate = null;
		this.editor.setValue(body, true);
		this.lastKnownContent = content;
		this.externalReloadPending = false;
		// The held height belongs to content that is no longer what the day
		// holds; the editor's own height is the honest one now.
		this.releaseHeight();
		this.updateBlankState();
		this.host.onDayContentChanged(this);
	}

	/** Brings the day up to date with the note's current content on disk. */
	async reload(knownContent?: string): Promise<void> {
		const content = knownContent ?? (await this.readContent());
		if (this.destroyed) return;
		if (this.editor) {
			this.applyExternalContent(content);
			return;
		}
		if (content === this.lastKnownContent && this.previewComponent) return;
		this.lastKnownContent = content;
		await this.renderPreview(content);
		this.host.onDayContentChanged(this);
	}

	/* ---------------------------------------------------------------- saving */

	private scheduleSave(): void {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flush(), this.host.plugin.settings.saveDelay);
	}

	/**
	 * Hands the editor's current text to the save queue. Once submitted the
	 * text no longer depends on the editor, so the day is free to be destroyed.
	 */
	private capture(): void {
		if (!this.editor) return;
		const body = this.editor.getValue();
		if (body === this.pendingTemplate) return; // an offer nobody accepted
		this.pendingTemplate = null;
		if (body !== editorBody(this.lastKnownContent)) void this.queue.submit(body);
	}

	async flush(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		this.capture();
		await this.queue.settled();
		if (!this.destroyed && this.externalReloadPending && !this.isDirty) await this.reload();
	}

	private async writeValue(body: string): Promise<boolean> {
		try {
			let file = this.file;
			if (!file) {
				// An untouched placeholder must not litter the vault with empty notes.
				if (!body.trim()) {
					this.lastKnownContent = body;
					return true;
				}
				// Created from the template, then written over below: the reader
				// is already typing into the template's body, and going through
				// it here is what carries its frontmatter onto the new note.
				file = await this.host.plugin.daily.create(this.date);
				this.setFile(file);
			}
			// The callback receives the latest vault content, so frontmatter changes
			// made by Properties, Sync, or another view are not overwritten.
			this.lastKnownContent = await this.host.app.vault.process(file, (content) =>
				replaceNoteBody(content, body),
			);
			return true;
		} catch (error) {
			console.error(`Journal View: could not save ${this.path}`, error);
			new Notice(`Journal View: could not save ${this.path}`);
			return false;
		}
	}

	private async createNow(): Promise<void> {
		if (this.file) return;
		try {
			const file = await this.host.plugin.daily.create(this.date);
			this.setFile(file);
			await this.reload();
			this.focusEditor();
		} catch (error) {
			console.error(`Journal View: could not create ${this.path}`, error);
			new Notice(`Journal View: could not create ${this.path}`);
		}
	}

	private async openInTab(newTab: boolean): Promise<void> {
		let file = this.file;
		if (!file) {
			try {
				file = await this.host.plugin.daily.create(this.date);
				this.setFile(file);
			} catch (error) {
				console.error(`Journal View: could not create ${this.path}`, error);
				return;
			}
		}
		await this.host.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	destroy(): void {
		this.destroyed = true;
		this.focusSettleToken++;
		window.clearTimeout(this.saveTimer);
		this.stopRevealing();
		// Anything unsaved goes to the queue, which outlives this object.
		this.capture();
		this.clearFindState();
		this.editor?.destroy();
		this.editor = null;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.el.remove();
	}
}
