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
 * - Preview: the note rendered as static markdown. Static DOM is fully laid
 *   out at its true height, which is what makes the journal scroll dead
 *   stable - an editor, by contrast, renders lazily and keeps re-measuring
 *   the parts of a long note that scroll into view.
 * - Edit: a real editor, entered by clicking into the day. Only the day
 *   being written in is ever an editor; it returns to a preview on blur.
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

		// Links in the preview navigate; they should not start an edit.
		const link = target.closest("a");
		if (link && !this.editor) {
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

		if (this.editor) {
			if (!this.editor.hasFocus() && event.target === this.bodyEl) this.editor.focus();
			return;
		}
		if (!target.closest(".journal-day-body")) return;
		// A click that ends a text selection is a copy gesture, not an edit.
		if (window.getSelection()?.toString()) return;
		this.beginEdit(event);
	}

	/* ---------------------------------------------------------------- state */

	get isToday(): boolean {
		return this.offset === 0;
	}

	get exists(): boolean {
		return this.file !== null;
	}

	get isEditing(): boolean {
		return this.editor !== null;
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
		this.el.removeClass("journal-day-editing");
		this.bodyEl.appendChild(built.container);
		this.el.toggleClass("journal-day-blank", noteBody(content).trim().length === 0);
	}

	private async renderPreview(content: string): Promise<void> {
		if (this.destroyed || this.editor) return;
		const built = await this.buildPreview(content);
		if (!built) return;
		if (this.editor) {
			// The reader started editing while the preview rendered; theirs wins.
			built.component.unload();
			return;
		}
		this.applyPreview(built, content);
	}

	/* -------------------------------------------------------------- editing */

	/** Swaps the preview for a live editor and puts the cursor in it. */
	beginEdit(event?: MouseEvent): void {
		if (this.destroyed) return;
		if (this.editor) {
			this.editor.focus();
			return;
		}
		// Hold the day at least at its preview height while it is edited: a
		// fresh editor renders a long note lazily and would briefly collapse
		// it, reflowing everything below the click.
		const held = this.bodyEl.offsetHeight;
		this.previewComponent?.unload();
		this.previewComponent = null;
		this.bodyEl.empty();
		if (held > 0) this.bodyEl.setCssProps({ "--journal-held-height": `${held}px` });
		this.el.addClass("journal-day-editing");
		const body = noteBody(this.lastKnownContent);
		const placeholder = this.exists ? "Empty note" : "Start typing to create this note";
		this.editor = createJournalEditor(
			{
				app: this.host.app,
				container: this.bodyEl,
				value: body,
				placeholder,
				file: this.file,
				onChange: () => {
					this.updateBlankState();
					this.scheduleSave();
				},
				onFocus: () => {
					this.focused = true;
					this.el.addClass("journal-day-focused");
				},
				onBlur: () => this.onEditorBlur(),
			},
			this.host.plugin.settings.richEditor,
		);
		this.updateBlankState();
		this.editor.focus();
		if (event) this.editor.placeCursor?.(event.clientX, event.clientY);
	}

	/**
	 * Leaving the editor returns the day to a static preview, so its height
	 * goes back to being fixed. Losing focus to another window is not
	 * leaving - the reader expects their cursor to survive a cmd-tab.
	 */
	private onEditorBlur(): void {
		this.focused = false;
		this.el.removeClass("journal-day-focused");
		if (!this.el.ownerDocument.hasFocus()) return;
		if (!this.editor) return;
		const value = replaceNoteBody(this.lastKnownContent, this.editor.getValue());
		void this.flush();
		this.lastKnownContent = value;
		void this.swapToPreview(value);
	}

	/**
	 * Builds the preview while the editor still stands, then swaps the two in
	 * one step - the day never spends a frame at zero height.
	 */
	private async swapToPreview(value: string): Promise<void> {
		const built = await this.buildPreview(value);
		if (!built) return;
		if (!this.editor || this.hasFocus) {
			// Editing resumed (or ended another way) while the preview
			// rendered; keep the editor.
			built.component.unload();
			return;
		}
		this.applyPreview(built, value);
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
		this.beginEdit();
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
			this.beginEdit();
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
