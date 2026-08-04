import { App, Component, MarkdownRenderer, Notice, TFile, getFrontMatterInfo, setIcon, setTooltip } from "obsidian";
import type { Moment } from "moment";
import type JournalViewPlugin from "./main";
import { JournalEditor, createJournalEditor } from "./editor";
import { SaveQueue } from "./saveQueue";

/** The bits of the journal view a day needs to talk to. */
export interface DayHost {
	app: App;
	plugin: JournalViewPlugin;
	/** Called when a day's underlying file appears, disappears or is renamed. */
	onDayFileChanged(day: DaySection, previousPath: string | null): void;
	/** True while a day is out of sight, where its body can be swapped unseen. */
	isOffScreen(day: DaySection): boolean;
}

/**
 * The journal edits only the note body. Obsidian's parser locates frontmatter
 * so it can be preserved exactly rather than parsed and serialized again.
 */
function noteBody(content: string): string {
	return content.slice(getFrontMatterInfo(content).contentStart);
}

function replaceNoteBody(content: string, body: string): string {
	return content.slice(0, getFrontMatterInfo(content).contentStart) + body;
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

	private headerEl: HTMLElement;
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
	/** Preview height (px) the editor is held at until the reader types. */
	private heldHeight = 0;

	private lastKnownContent = "";
	private saveTimer = 0;
	private focused = false;
	private readonly queue = new SaveQueue((value) => this.writeValue(value));

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
		this.headerEl = this.el.createDiv({ cls: "journal-day-header" });
		const titleEl = this.headerEl.createDiv({ cls: "journal-day-title" });
		titleEl.createSpan({ cls: "journal-day-date", text: this.formatHeader() });
		const relative = this.relativeLabel();
		if (relative) titleEl.createSpan({ cls: "journal-day-badge", text: relative });
		this.actionsEl = this.headerEl.createDiv({ cls: "journal-day-actions" });

		this.bodyEl = this.el.createDiv({ cls: "journal-day-body" });

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

	private formatHeader(): string {
		return this.date.format(this.host.plugin.settings.headerFormat);
	}

	private relativeLabel(): string | null {
		if (this.offset === 0) return "Today";
		if (this.offset === -1) return "Yesterday";
		if (this.offset === 1) return "Tomorrow";
		return null;
	}

	/** Re-applies the classes and header buttons that depend on the file. */
	refreshState(): void {
		this.el.toggleClass("journal-day-today", this.isToday);
		this.el.toggleClass("journal-day-empty", !this.exists);
		this.el.toggleClass("journal-day-future", this.offset > 0);
		this.el.toggleClass(
			"journal-day-hidden",
			!this.exists && !this.isToday && this.host.plugin.settings.hideEmptyDays,
		);

		this.bodyEl.dataset.placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		this.actionsEl.empty();
		setTooltip(this.headerEl, this.path, { placement: "right" });

		if (this.exists) {
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
		return !!this.editor && this.editor.getValue() !== noteBody(this.lastKnownContent);
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
	 * The day is held at its preview height until someone types in it: an
	 * editor lays out the parts of a long note it cannot see lazily, and its
	 * first guess at their height is only a guess.
	 */
	mountEditor(): void {
		if (this.destroyed || this.editor) return;
		this.modeToken++;
		this.heldHeight = this.bodyEl.offsetHeight;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.bodyEl.empty();
		if (this.heldHeight > 0) this.bodyEl.setCssProps({ "--journal-held-height": `${this.heldHeight}px` });
		this.el.addClass("journal-day-editing");
		const body = noteBody(this.lastKnownContent);
		const placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		try {
			this.editor = createJournalEditor(
				{
					app: this.host.app,
					container: this.bodyEl,
					value: body,
					placeholder,
					file: this.file,
					onChange: () => {
						this.releaseHeight();
						this.updateBlankState();
						this.scheduleSave();
					},
					onFocus: () => {
						this.focused = true;
						// The day is on screen and the editor has measured what
						// it shows, so its own height can be trusted from here.
						this.releaseHeight();
						this.el.addClass("journal-day-focused");
					},
					onBlur: () => this.onEditorBlur(),
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

	/** Blurring an editor is not leaving the day, but it is a good time to save. */
	private onEditorBlur(): void {
		this.focused = false;
		this.el.removeClass("journal-day-focused");
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

	focusEditor(): void {
		this.mountEditor();
		this.editor?.focus();
	}

	/** Applies a change that happened outside the journal (sync, another tab). */
	applyExternalContent(content: string): void {
		if (!this.editor) {
			this.lastKnownContent = content;
			return;
		}
		const body = noteBody(content);
		if (this.editor.getValue() === body) {
			this.lastKnownContent = content;
			return;
		}
		if (this.hasFocus || this.isDirty) return; // never clobber the user's typing

		this.editor.setValue(body);
		this.lastKnownContent = content;
		// The held height belongs to content that is no longer what the day
		// holds; the editor's own height is the honest one now.
		this.releaseHeight();
		this.updateBlankState();
	}

	/** Brings the day up to date with the note's current content on disk. */
	async reload(): Promise<void> {
		const content = await this.readContent();
		if (this.destroyed) return;
		if (this.editor) {
			this.applyExternalContent(content);
			return;
		}
		if (content === this.lastKnownContent && this.previewComponent) return;
		this.lastKnownContent = content;
		await this.renderPreview(content);
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
		if (body !== noteBody(this.lastKnownContent)) void this.queue.submit(body);
	}

	async flush(): Promise<void> {
		window.clearTimeout(this.saveTimer);
		this.capture();
		await this.queue.settled();
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
				file = await this.host.plugin.daily.create(this.date, body);
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
		window.clearTimeout(this.saveTimer);
		// Anything unsaved goes to the queue, which outlives this object.
		this.capture();
		this.editor?.destroy();
		this.editor = null;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.el.remove();
	}
}
