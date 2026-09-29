import { App, TFile, setTooltip } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type JournalViewPlugin from "./main";
import { EntryHost, NoteEntry } from "./entry";
import type { Moment } from "./moment";

/** The bits of the journal view a day needs to talk to. */
export interface DayHost {
	app: App;
	leaf: WorkspaceLeaf;
	plugin: JournalViewPlugin;
	/** Called when a day's underlying file appears, disappears or is renamed. */
	onDayFileChanged(day: DaySection, previousPath: string | null): void;
	/** True when this date passes the journal's current visibility rules. */
	isVisibleDay(day: DaySection): boolean;
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
 */
export class DaySection implements EntryHost {
	readonly el: HTMLElement;
	readonly key: string;
	/** The notes shown under this date, in order. */
	readonly entries: NoteEntry[];

	private yearEl: HTMLElement;
	private monthEl: HTMLElement;
	private cardEl: HTMLElement;
	private headerEl: HTMLElement;
	private titleEl: HTMLElement;
	private actionsEl: HTMLElement;
	private destroyed = false;

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
			const relative = this.relativeLabel();
			if (relative) this.titleEl.createSpan({ cls: "journal-day-badge", text: relative });
		} else {
			this.titleEl.hidden = true;
		}
		this.actionsEl = this.headerEl.createDiv({ cls: "journal-day-actions" });

		const daily = host.plugin.daily;
		const entry = new NoteEntry(this, daily.fileFor(date), daily.pathFor(date));
		this.entries = [entry];
		this.cardEl.appendChild(entry.el);

		this.el.addEventListener("focusout", () => {
			// Focus often moves between the editor and metadata controls inside the
			// same day. Wait for that move to settle before releasing the temporary
			// focused-day visibility guard.
			window.setTimeout(() => {
				if (!this.destroyed && !this.hasFocus) this.host.onDayFocusChanged(this);
			}, 0);
		});

		this.refreshState();
	}

	get app(): App {
		return this.host.app;
	}

	get leaf(): WorkspaceLeaf {
		return this.host.leaf;
	}

	get plugin(): JournalViewPlugin {
		return this.host.plugin;
	}

	/** The entry the header's buttons act on. */
	private get lead(): NoteEntry {
		return this.entries[0];
	}

	/** Where the day's note lives, or will once it is written. */
	get path(): string {
		return this.lead.path;
	}

	get file(): TFile | null {
		return this.lead.file;
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

	/** Re-applies the classes and header buttons that depend on the day's notes. */
	refreshState(): void {
		this.el.toggleClass("journal-day-today", this.isToday);
		this.el.toggleClass("journal-day-empty", !this.exists);
		this.el.toggleClass("journal-day-future", this.offset > 0);
		this.refreshVisibility();

		this.actionsEl.empty();
		setTooltip(this.titleEl, this.path, { placement: "right" });
		this.lead.renderActions(this.actionsEl);
		for (const entry of this.entries) entry.refreshState();
	}

	/** Re-applies only the state that can change when focus leaves a filtered day. */
	refreshVisibility(): void {
		this.el.toggleClass("journal-day-hidden", !this.host.isVisibleDay(this));
	}

	/** Repaints every entry's metadata strip from its latest content. */
	refreshMetadata(): void {
		for (const entry of this.entries) entry.refreshMetadata();
	}

	/** Recomputes the expected path, e.g. after the date format changed. */
	revalidate(): void {
		const entry = this.lead;
		if (!entry.revalidate()) return;
		this.refreshState();
		void entry.reload();
	}

	setFile(file: TFile | null): void {
		this.lead.setFile(file);
	}

	/**
	 * Reads every entry and renders its preview. The view awaits this before
	 * the day enters the DOM, so a day is always inserted at its full height.
	 */
	async prepare(): Promise<void> {
		await Promise.all(this.entries.map((entry) => entry.prepare()));
	}

	/** Brings the day's note up to date with its current content on disk. */
	async reload(knownContent?: string): Promise<void> {
		await this.lead.reload(knownContent);
	}

	/**
	 * Puts the reader in the day's editor. `atEnd` carries on after the last
	 * entry, which is where writing continues; otherwise the first one takes it.
	 * Returns false when the guarded editor mount failed.
	 */
	focusEditor(atEnd = false): boolean {
		const entry = atEnd ? this.entries[this.entries.length - 1] : this.entries[0];
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
		this.refreshState();
		this.host.onDayFileChanged(this, previousPath);
	}

	onEntryContentChanged(_entry: NoteEntry): void {
		this.host.onDayContentChanged(this);
	}

	onEntryFocus(_entry: NoteEntry): void {
		this.el.toggleClass(
			"journal-day-focused",
			this.entries.some((entry) => entry.isEditorFocused),
		);
	}

	onEntryFocusChanged(_entry: NoteEntry): void {
		this.host.onDayFocusChanged(this);
	}

	onEntryFocusSettled(_entry: NoteEntry): void {
		this.host.onDayFocusSettled(this);
	}

	showFind(): void {
		this.host.showFind();
	}
}
