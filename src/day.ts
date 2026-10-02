import { App, Notice, TFile, normalizePath, setIcon, setTooltip } from "obsidian";
import type { HoverParent, WorkspaceLeaf } from "obsidian";
import type JournalViewPlugin from "./main";
import { DayFilesHost, DayFilesList } from "./dayFilesList";
import { EntryHost, NoteEntry } from "./entry";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { INVALID_TITLE_CHARACTERS, renderNoteLabel } from "./noteLabel";
import type { NoteLabel } from "./noteLabel";

/** The bits of the journal view a day needs to talk to. Its page previews hang off the view. */
export interface DayHost extends HoverParent {
	app: App;
	leaf: WorkspaceLeaf;
	plugin: JournalViewPlugin;
	/** Whether the reader left this day's list of files open. */
	isFilesOpen(day: DaySection): boolean;
	setFilesOpen(day: DaySection, open: boolean): void;
	/** Called when one of a day's files appears, disappears or is renamed. */
	onDayFileChanged(day: DaySection, previousPath: string | null): void;
	/** Shows a note the day created, without waiting for the vault to announce it. */
	onDayNoteCreated(file: TFile): void;
	/** True when this date passes the journal's current visibility rules. */
	isVisibleDay(day: DaySection): boolean;
	/** True when this note passes the journal's filters on its own. */
	isVisibleEntry(day: DaySection, entry: NoteEntry): boolean;
	/** True while `el` is out of sight, where a body inside it can be swapped unseen. */
	isOffScreen(el: HTMLElement): boolean;
	/** Re-indexes find results after one of this day's visible bodies changes. */
	onDayContentChanged(day: DaySection): void;
	/** Re-applies filtering after a focused editing session settles. */
	onDayFocusChanged(day: DaySection): void;
	/** Re-centres a navigation after focus-driven editor and template layout settles. */
	onDayFocusSettled(day: DaySection): void;
	/** Opens the journal-wide find UI from an embedded editor command. */
	showFind(): void;
}

/**
 * One date in the journal: its headings, its header, and the notes written
 * under it. The day is the unit the view loads, trims and anchors the scroll
 * position to; everything that belongs to a note - its editor or preview, its
 * properties, saving and find state - lives in a `NoteEntry`.
 *
 * A day always holds at least one entry. With no note yet, that entry has no
 * file and stands in for the note the reader can start writing. Below its
 * notes, a day can list the other files from that date.
 */
export class DaySection implements EntryHost, DayFilesHost {
	readonly el: HTMLElement;
	readonly key: string;
	/** The notes shown under this date, in order. */
	readonly entries: NoteEntry[] = [];

	private yearEl: HTMLElement;
	private monthEl: HTMLElement;
	private cardEl: HTMLElement;
	private headerEl: HTMLElement;
	private titleEl: HTMLElement;
	/** Names the first note when the file name says more than the date, e.g. its time. */
	private noteLabelEl: HTMLElement;
	private actionsEl: HTMLElement;
	private entriesEl: HTMLElement;
	/** Today's button that adds another note, while the day can hold several. */
	private addNoteEl: HTMLElement | null = null;
	/** The files from this date, while the journal lists them. */
	private files: DayFilesList | null;
	private destroyed = false;
	/** Set while entries are reconciled, which refreshes the day once at the end. */
	private syncing = false;

	constructor(
		private host: DayHost,
		readonly date: Moment,
		readonly offset: number,
	) {
		this.key = date.format("YYYY-MM-DD");

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
		const headerStyle = this.host.plugin.settings.headerStyle;
		this.headerEl = this.cardEl.createDiv({
			cls: `journal-day-header journal-day-header-${headerStyle}`,
		});
		this.titleEl = this.headerEl.createDiv({ cls: "journal-day-title" });
		if (headerStyle !== "hidden") {
			this.titleEl.createSpan({
				cls: "journal-day-date",
				text: this.formatHeader(),
			});
		} else {
			this.titleEl.hidden = true;
		}
		this.noteLabelEl = this.titleEl.createSpan({ cls: "journal-day-note-label" });
		this.noteLabelEl.hidden = true;
		const relative = this.relativeLabel();
		if (relative && headerStyle !== "hidden") {
			this.titleEl.createSpan({ cls: "journal-day-badge", text: relative });
		}
		this.actionsEl = this.headerEl.createDiv({ cls: "journal-day-actions" });
		this.entriesEl = this.cardEl.createDiv({ cls: "journal-day-entries" });
		if (this.isToday && this.host.plugin.settings.multipleNotesPerDay) {
			this.addNoteEl = this.cardEl.createDiv({ cls: "journal-day-add" });
			const add = this.addNoteEl.createEl("button", { cls: "clickable-icon journal-day-add-button" });
			setIcon(add, "file-plus");
			setTooltip(add, "Add a note to today");
			add.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.addNote();
			});
		}
		this.files = this.host.plugin.settings.showDayFiles ? new DayFilesList(this, this.el) : null;

		this.el.addEventListener("focusout", () => {
			// Focus often moves between the editor and metadata controls inside the
			// same day. Wait for that move to settle before releasing the temporary
			// focused-day visibility guard.
			window.setTimeout(() => {
				if (!this.destroyed && !this.hasFocus) this.onFocusLeft();
			}, 0);
		});

		this.syncEntries();
		this.refreshFiles();
	}

	get app(): App {
		return this.host.app;
	}

	get hoverParent(): HoverParent {
		return this.host;
	}

	get leaf(): WorkspaceLeaf {
		return this.host.leaf;
	}

	get plugin(): JournalViewPlugin {
		return this.host.plugin;
	}

	/** The entry directly under the header, which the header's buttons act on. */
	private get lead(): NoteEntry {
		return this.entries.find((entry) => !entry.isHidden) ?? this.entries[0];
	}

	/** The entry showing `file`, if this day has one. */
	entryFor(file: TFile): NoteEntry | undefined {
		return this.entries.find((entry) => entry.file === file);
	}

	/**
	 * Where `entry` sits in the scroller's content, when navigation aims at it
	 * rather than at the day: null for the note directly under the header,
	 * which the day as a whole already frames.
	 */
	boxFor(entry?: NoteEntry): { top: number; height: number } | null {
		if (!entry || entry === this.lead || !this.entries.includes(entry)) return null;
		// The card is the notes' positioned ancestor.
		return { top: this.cardTop + entry.el.offsetTop, height: entry.el.offsetHeight };
	}

	/* ---------------------------------------------------------------- state */

	get isToday(): boolean {
		return this.offset === 0;
	}

	get exists(): boolean {
		return this.entries.some((entry) => entry.exists);
	}

	/** False for a day the layout is ignoring, e.g. a hidden empty day. */
	get isLaidOut(): boolean {
		return this.el.offsetParent !== null;
	}

	/** Viewport position of stable day content, below any movable date headings. */
	get contentTop(): number {
		return this.headerEl.getBoundingClientRect().top;
	}

	/** Top of the whole day, headings included - where the day starts on screen. */
	get dayTop(): number {
		return this.el.offsetTop;
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

	get hasFocus(): boolean {
		return this.entries.some((entry) => entry.hasFocus);
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

	/**
	 * What names a note beyond its date: the time its file name records, when
	 * the date format has one, and any text after the date when a day holds
	 * several notes. A note that is not the first shown in its day
	 * always needs a name, so it falls back to the file's own.
	 */
	private labelFor(entry: NoteEntry, required: boolean): NoteLabel | null {
		const { daily, index } = this.host.plugin;
		const location = entry.file ? index.locate(entry.file.path) : null;
		const text = location && daily.recordsTime() ? createMoment(location.time).format("LT") : null;
		const title = location?.suffix || null;
		if (text || title) return { text, title };
		if (!required) return null;
		return { text: entry.file ? entry.file.basename : "New note", title: null };
	}

	/**
	 * Renames a note to `title` after its date, keeping the date and what sets
	 * the title off from it as they were. Links to the note follow, as they do
	 * for any rename in Obsidian.
	 */
	private async retitle(entry: NoteEntry, title: string): Promise<void> {
		const { app, plugin } = this.host;
		const file = entry.file;
		const suffix = file ? plugin.index.locate(file.path)?.suffix : null;
		if (!file || !suffix) return;
		if (INVALID_TITLE_CHARACTERS.test(title)) {
			new Notice(`Journal View: "${title}" holds a character a note's name cannot: \\ / : * ? " < > | # ^ [ ]`);
			return;
		}
		const base = file.basename;
		const kept = base.endsWith(suffix) ? base.slice(0, -suffix.length) : `${base} `;
		const parent = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
		const path = normalizePath(`${parent}${kept}${title}.${file.extension}`);
		if (path === file.path) return;
		if (plugin.index.locate(path)?.key !== this.key) {
			new Notice(`Journal View: "${title}" would move the note off this day`);
			return;
		}
		if (app.vault.getAbstractFileByPath(path)) {
			new Notice(`Journal View: ${path} already exists`);
			return;
		}
		try {
			await app.fileManager.renameFile(file, path);
		} catch (error) {
			console.error(`Journal View: could not rename ${file.path}`, error);
			new Notice(`Journal View: could not rename ${file.path}`);
		}
	}

	/** Lets the reader rename `entry` by its title, when it has one. */
	private retitler(entry: NoteEntry): ((title: string) => void) | undefined {
		if (!entry.file || !this.host.plugin.settings.multipleNotesPerDay) return undefined;
		return (title) => void this.retitle(entry, title);
	}

	/** Re-applies the classes and header buttons that depend on the day's notes. */
	refreshState(): void {
		this.el.toggleClass("journal-day-today", this.isToday);
		this.el.toggleClass("journal-day-empty", !this.exists);
		this.el.toggleClass("journal-day-future", this.offset > 0);
		if (this.addNoteEl) this.addNoteEl.hidden = !this.exists;
		for (const entry of this.entries) entry.refreshState();
		this.refreshVisibility(true);
	}

	/**
	 * Re-applies the journal's rules to the day and to each note in it, and
	 * reports whether anything changed. A day that is shown although none of
	 * its notes pass - Today, or a date reached by command - shows them all
	 * rather than an empty card.
	 */
	refreshVisibility(relayout = false): boolean {
		const dayHidden = !this.host.isVisibleDay(this);
		let changed = dayHidden !== this.isHidden;
		this.el.toggleClass("journal-day-hidden", dayHidden);
		const passing = this.entries.filter((entry) => this.host.isVisibleEntry(this, entry));
		const shown = new Set(passing.length ? passing : this.entries);
		for (const entry of this.entries) {
			const hidden = !shown.has(entry);
			if (entry.isHidden === hidden) continue;
			entry.setHidden(hidden);
			changed = true;
			relayout = true;
		}
		if (relayout) this.layoutEntries();
		return changed;
	}

	/**
	 * Puts the first shown note directly under the day's header, which carries
	 * its buttons, and gives every further note a divider of its own.
	 */
	private layoutEntries(): void {
		const lead = this.lead;
		for (const entry of this.entries) entry.el.toggleClass("journal-entry-lead", entry === lead);
		this.syncFocusClasses();
		this.actionsEl.empty();
		setTooltip(this.titleEl, lead.path, { placement: "right" });
		lead.renderActions(this.actionsEl);
		const label = this.labelFor(lead, false);
		renderNoteLabel(this.noteLabelEl, label ?? { text: null, title: null }, this.retitler(lead));
		this.noteLabelEl.hidden = label === null;
		for (const entry of this.entries) {
			if (entry === lead) entry.setHeading(null);
			else entry.setHeading(this.labelFor(entry, true), this.retitler(entry));
		}
	}

	/**
	 * Brings the entries in line with the notes indexed for this date. Entries
	 * of notes that are still here are kept - and with them any editor, focus
	 * or unsaved text. Returns the entries whose content has to be read.
	 */
	syncEntries(): NoteEntry[] {
		const { app, plugin } = this.host;
		const files = plugin.index
			.pathsFor(this.key)
			.map((path) => app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile);
		const unclaimed = new Set(this.entries);
		const next: NoteEntry[] = [];
		const stale: NoteEntry[] = [];
		this.syncing = true;
		try {
			for (const file of files) {
				const entry =
					this.entries.find((candidate) => unclaimed.has(candidate) && candidate.file === file) ??
					// An entry creating its note claims the path first.
					this.entries.find(
						(candidate) => unclaimed.has(candidate) && !candidate.file && candidate.path === file.path,
					);
				if (!entry) {
					const added = new NoteEntry(this, file, file.path);
					next.push(added);
					stale.push(added);
					continue;
				}
				unclaimed.delete(entry);
				if (entry.file === file) entry.syncPath();
				else {
					entry.setFile(file);
					stale.push(entry);
				}
				next.push(entry);
			}

			for (const entry of unclaimed) {
				const file = entry.file;
				if (file && app.vault.getAbstractFileByPath(file.path) === file) {
					// Renamed to another day, or out of the journal. Pending edits
					// are handed to the save queue, which follows the file.
					entry.destroy();
				} else if (file && entry.isDirty) {
					// Deleted under unsaved edits, which are kept and written
					// back as the note on the next save.
					entry.detachFile();
					next.push(entry);
				} else if (file) {
					// Deleted. The entry goes, unless the day now needs one to
					// stand in for its missing note.
					if (next.length) {
						entry.destroy();
						continue;
					}
					entry.setFile(null);
					next.push(entry);
					stale.push(entry);
				} else if (entry.isDirty || entry.hasFocus || !next.length) {
					// Not written yet. Kept while the reader is in it or has typed
					// in it, and as the stand-in for a day without notes.
					if (!entry.isDirty) entry.standIn(plugin.daily.pathFor(this.date));
					next.push(entry);
				} else {
					entry.destroy();
				}
			}

			if (!next.length) {
				const placeholder = new NoteEntry(this, null, plugin.daily.pathFor(this.date));
				next.push(placeholder);
				stale.push(placeholder);
			}
		} finally {
			this.syncing = false;
		}

		this.entries.splice(0, this.entries.length, ...next);
		this.placeEntries();
		this.refreshState();
		return stale.filter((entry) => this.entries.includes(entry));
	}

	/**
	 * Arranges the entry elements in entry order. Moving an element takes focus
	 * out of it, so an entry the reader is in stays put and the others are
	 * arranged around it.
	 */
	private placeEntries(): void {
		const elements = this.entries.map((entry) => entry.el);
		const current = Array.from(this.entriesEl.children);
		if (current.length === elements.length && current.every((el, index) => el === elements[index])) return;
		const pivot = this.entries.find((entry) => entry.hasFocus)?.el;
		if (!pivot || pivot.parentElement !== this.entriesEl) {
			this.entriesEl.append(...elements);
			return;
		}
		const at = elements.indexOf(pivot);
		pivot.before(...elements.slice(0, at));
		pivot.after(...elements.slice(at + 1));
	}

	/** Repaints every entry's metadata strip from its latest content. */
	refreshMetadata(): void {
		for (const entry of this.entries) entry.refreshMetadata();
	}

	/** Lists the files from this date again, after they changed. */
	refreshFiles(): void {
		this.files?.update(this.host.plugin.dayFiles.filesFor(this.key));
	}

	isFilesOpen(): boolean {
		return this.host.isFilesOpen(this);
	}

	setFilesOpen(open: boolean): void {
		this.host.setFilesOpen(this, open);
	}

	/**
	 * Reads every entry and renders its preview. The view awaits this before
	 * the day enters the DOM, so a day is always inserted at its full height.
	 */
	async prepare(): Promise<void> {
		await Promise.all(this.entries.map((entry) => entry.prepare()));
	}

	/**
	 * Adds another note to the day, named after the current time, and puts
	 * the reader in it. The note is created straight away, from the template.
	 */
	private async addNote(): Promise<void> {
		const daily = this.host.plugin.daily;
		const at = daily.atCurrentTime(this.date);
		const preferred = daily.addedNotePath(at);
		let file: TFile;
		try {
			file = await daily.create(at, preferred, undefined, true);
		} catch (error) {
			console.error(`Journal View: could not create ${preferred}`, error);
			new Notice(`Journal View: could not create ${preferred}`);
			return;
		}
		if (this.destroyed) return;
		this.host.onDayNoteCreated(file);
		const entry = this.entryFor(file);
		if (!entry) return;
		await entry.reload();
		if (!this.destroyed && this.entries.includes(entry)) this.focusEditor(true, entry);
	}

	/** Brings every note in the day up to date with its content on disk. */
	async reload(): Promise<void> {
		await Promise.all(this.entries.map((entry) => entry.reload()));
	}

	/**
	 * Puts the reader in the day's editor: in `target` when navigation named a
	 * note, otherwise after the last shown note for `atEnd`, which is where
	 * writing continues, or in the first. Returns false when the guarded
	 * editor mount failed.
	 */
	focusEditor(atEnd = false, target?: NoteEntry): boolean {
		const shown = this.entries.filter((entry) => !entry.isHidden);
		const entry =
			(target && shown.includes(target) ? target : atEnd ? shown[shown.length - 1] : shown[0]) ??
			this.entries[0];
		return entry.focusEditor(atEnd);
	}

	async flush(commitMetadataDraft = false): Promise<void> {
		await Promise.all(this.entries.map((entry) => entry.flush(commitMetadataDraft)));
	}

	destroy(): void {
		this.destroyed = true;
		for (const entry of this.entries) entry.destroy();
		this.el.remove();
	}

	/* ----------------------------------------------------------- entry host */

	isOffScreen(entry: NoteEntry): boolean {
		return this.host.isOffScreen(entry.el);
	}

	onEntryFileChanged(_entry: NoteEntry, previousPath: string | null): void {
		if (this.syncing) return;
		this.refreshState();
		this.host.onDayFileChanged(this, previousPath);
	}

	onEntryContentChanged(_entry: NoteEntry): void {
		this.host.onDayContentChanged(this);
	}

	onEntryFocus(_entry: NoteEntry): void {
		this.syncFocusClasses();
	}

	/**
	 * Marks the day while the reader writes in it, and separately while they
	 * write in the note whose buttons sit in the day's header - a note's
	 * buttons show for the note being written in, not for the day.
	 */
	private syncFocusClasses(): void {
		this.el.toggleClass("journal-day-focused", this.entries.some((entry) => entry.isEditorFocused));
		this.el.toggleClass("journal-day-lead-active", this.lead.isEditorFocused);
	}

	onEntryFocusChanged(_entry: NoteEntry): void {
		this.onFocusLeft();
	}

	/**
	 * Focus left an entry, or the day. An empty entry kept only because the
	 * reader was in it has served its purpose once they leave without writing,
	 * if the day has notes of its own.
	 */
	private onFocusLeft(): void {
		const unused = this.entries.filter(
			(entry) => !entry.file && !entry.isDirty && !entry.hasFocus && this.entries.some((other) => other.file),
		);
		for (const entry of unused) {
			this.entries.splice(this.entries.indexOf(entry), 1);
			entry.destroy();
		}
		if (unused.length) {
			this.refreshState();
			for (const entry of unused) this.host.onDayFileChanged(this, entry.path);
		}
		this.host.onDayFocusChanged(this);
	}

	onEntryFocusSettled(_entry: NoteEntry): void {
		this.host.onDayFocusSettled(this);
	}

	showFind(): void {
		this.host.showFind();
	}
}
