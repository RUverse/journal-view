import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import type JournalViewPlugin from "./main";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { columnsThatFit, cssPixels } from "./mosaicColumns";
import { NewWordsMosaic } from "./newWords";
import { DAY_KEY_FORMAT } from "./noteIndex";
import { NoteStatistics, wordCountLevel } from "./statistics";

export const VIEW_TYPE_STATISTICS = "journal-statistics";

interface DayTile {
	date: Moment;
	button: HTMLButtonElement;
	/** The day's notes, in journal order. */
	files: TFile[];
	/** One count per note; null while it is still being read. */
	counts: (NoteStatistics | null)[];
	/** The day as a whole: every note's words added up, once all are counted. */
	result: NoteStatistics | null;
}

/** Adds up a day's note counts; any note that could not be read makes the day unreadable. */
function combineCounts(counts: (NoteStatistics | null)[]): NoteStatistics | null {
	let words = 0;
	for (const count of counts) {
		if (count === null) return null;
		if (count.status === "error") return count;
		words += count.words;
	}
	return { status: "ready", words };
}

export class StatisticsView extends ItemView {
	private year = Number(createMoment().format("YYYY"));
	private tiles: DayTile[] = [];
	private paths = new Set<string>();
	private epoch = 0;
	private closed = true;
	private refreshTimer = 0;
	private configSignature = "";
	private yearInput!: HTMLInputElement;
	private previous!: HTMLButtonElement;
	private next!: HTMLButtonElement;
	private scroller!: HTMLElement;
	private grid!: HTMLElement;
	private weeks: HTMLElement[] = [];
	/** The first tile in a week that is not left out for want of room. */
	private firstShown = 0;
	private status!: HTMLElement;
	private detail!: HTMLElement;
	private openButton!: HTMLButtonElement;
	private selected: DayTile | null = null;
	private newWords: NewWordsMosaic | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: JournalViewPlugin) { super(leaf); }

	getViewType(): string { return VIEW_TYPE_STATISTICS; }
	getDisplayText(): string { return "Statistics"; }
	getIcon(): string { return "chart-no-axes-column-increasing"; }
	getState(): Record<string, unknown> { return { year: this.year }; }

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (typeof state === "object" && state !== null && "year" in state) {
			const year = state.year;
			if (typeof year === "number" && Number.isInteger(year) && year >= 1 && year <= 9999 && year !== this.year) {
				this.year = year;
				if (!this.closed) this.renderYear();
			}
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.contentEl.empty();
		this.contentEl.addClass("journal-statistics");
		const page = this.contentEl.createDiv({ cls: "journal-statistics-page" });
		const header = page.createDiv({ cls: "journal-statistics-header" });
		const heading = header.createDiv();
		heading.createEl("h2", { text: "Your year in words" });
		heading.createEl("p", { text: "A day at a time, a journal takes shape." });
		const navigation = header.createDiv({ cls: "journal-statistics-navigation" });
		this.previous = navigation.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Previous year" } });
		setIcon(this.previous, "chevron-left");
		this.yearInput = navigation.createEl("input", {
			type: "number", attr: { min: "1", max: "9999", step: "1", "aria-label": "Year" },
		});
		this.next = navigation.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Next year" } });
		setIcon(this.next, "chevron-right");
		const today = navigation.createEl("button", { text: "This year" });
		this.registerDomEvent(this.previous, "click", () => this.changeYear(this.year - 1));
		this.registerDomEvent(this.next, "click", () => this.changeYear(this.year + 1));
		this.registerDomEvent(today, "click", () => this.changeYear(Number(createMoment().format("YYYY"))));
		this.registerDomEvent(this.yearInput, "change", () => this.changeYear(Number(this.yearInput.value)));

		const card = page.createDiv({ cls: "journal-statistics-card" });
		this.scroller = card.createDiv({ cls: "journal-statistics-scroll" });
		this.grid = this.scroller.createDiv({ cls: "journal-statistics-grid", attr: { role: "group", "aria-label": "Daily note word counts" } });
		const legend = card.createDiv({ cls: "journal-statistics-legend" });
		for (const [level, label] of ["No note / 0 words", "1–149", "150–399", "400–999", "1,000+"].entries()) {
			const item = legend.createSpan();
			item.createSpan({ cls: `journal-statistics-swatch level-${level}`, attr: { "aria-hidden": "true" } });
			item.createSpan({ text: label });
		}
		this.status = card.createDiv({ cls: "journal-statistics-status", attr: { role: "status" } });
		const selection = card.createDiv({ cls: "journal-statistics-selection" });
		this.detail = selection.createSpan({ text: "Select a day to see its word count.", attr: { "aria-live": "polite" } });
		this.openButton = selection.createEl("button", { text: "Open in journal" });
		this.openButton.hidden = true;
		this.registerDomEvent(this.openButton, "click", () => {
			const tile = this.selected;
			if (!tile?.files.length || !this.plugin.index.has(tile.date.format(DAY_KEY_FORMAT))) return;
			void this.plugin.activateView(false, tile.date, false, true).catch((error: unknown) => {
				console.error("Journal View: could not open statistics entry", error);
				new Notice("Could not open this journal entry.");
			});
		});
		this.register(this.plugin.statistics.subscribe((paths, folder) => {
			const relevant = folder
				? paths.some((path) => Array.from(this.paths).some((note) => note.startsWith(`${path}/`)))
				: paths.some((path) => this.paths.has(path) || this.isNoteInYear(path));
			if (relevant) this.scheduleRefresh();
		}));
		const resize = new ResizeObserver(() => this.fitWeeks());
		resize.observe(this.scroller);
		this.register(() => resize.disconnect());
		this.newWords = this.addChild(new NewWordsMosaic(page, this.plugin));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onSettingsChanged()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onSettingsChanged()));
		this.renderYear();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		if (this.newWords) this.removeChild(this.newWords);
		this.newWords = null;
		this.tiles = [];
		this.weeks = [];
		this.paths.clear();
		this.selected = null;
	}

	/** True for a daily-note path dated in the year on screen, e.g. a note just added to a day. */
	private isNoteInYear(path: string): boolean {
		return this.plugin.index.keyForPath(path)?.startsWith(`${String(this.year).padStart(4, "0")}-`) ?? false;
	}

	onSettingsChanged(): void {
		this.newWords?.onSettingsChanged();
		if (!this.closed && this.configSignature !== JSON.stringify(this.plugin.daily.config())) this.scheduleRefresh();
	}

	private changeYear(year: number): void {
		if (!Number.isInteger(year) || year < 1 || year > 9999) {
			this.yearInput.value = String(this.year);
			return;
		}
		this.year = year;
		this.renderYear();
		this.app.workspace.requestSaveLayout();
	}

	private renderYear(): void {
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		this.grid.empty();
		this.tiles = [];
		this.weeks = [];
		this.selected = null;
		this.detail.setText("Select a day to see its word count.");
		this.openButton.hidden = true;
		this.yearInput.value = String(this.year);
		this.previous.disabled = this.year <= 1;
		this.next.disabled = this.year >= 9999;
		const first = createMoment(`${String(this.year).padStart(4, "0")}-01-01`, DAY_KEY_FORMAT, true);
		const last = first.clone().add(11, "month").date(31);
		const cursor = first.clone().startOf("week");
		const weekdays = this.grid.createDiv({ cls: "journal-statistics-weekdays", attr: { "aria-hidden": "true" } });
		weekdays.createSpan();
		for (let day = 0; day < 7; day++) weekdays.createSpan({ text: cursor.clone().add(day, "days").format("dd") });
		const today = createMoment().format(DAY_KEY_FORMAT);
		while (!cursor.isAfter(last)) {
			const week = this.grid.createDiv({ cls: "journal-statistics-week" });
			this.weeks.push(week);
			const month = week.createSpan({ cls: "journal-statistics-month", attr: { "aria-hidden": "true" } });
			for (let day = 0; day < 7; day++, cursor.add(1, "day")) {
				if (cursor.isBefore(first) || cursor.isAfter(last)) {
					week.createSpan({ cls: "journal-statistics-padding" });
					continue;
				}
				if (cursor.date() === 1) month.setText(cursor.format("MMM"));
				const key = cursor.format(DAY_KEY_FORMAT);
				const button = week.createEl("button", {
					cls: "journal-statistics-tile is-loading",
					attr: { "aria-label": `${cursor.format("LL")}: loading`, "data-date": key, tabindex: "-1" },
				});
				if (key === today) button.setAttribute("aria-current", "date");
				const tile: DayTile = { date: cursor.clone(), button, files: [], counts: [], result: null };
				this.tiles.push(tile);
				button.addEventListener("click", () => this.select(tile));
				button.addEventListener("focus", () => this.select(tile));
				button.addEventListener("keydown", (event) => this.navigateGrid(event, tile));
			}
		}
		const initial = this.tiles.find((tile) => tile.date.format(DAY_KEY_FORMAT) === today) ?? this.tiles[0];
		if (initial) initial.button.tabIndex = 0;
		this.fitWeeks();
		void this.refreshCounts();
	}

	/**
	 * Leaves out the earliest weeks when the pane is too narrow for the whole
	 * year, so the rest shows without scrolling, and has the new-words mosaic
	 * below match the width of the weeks shown.
	 */
	private fitWeeks(): void {
		const fit = columnsThatFit(this.scroller, cssPixels(this.contentEl, "--journal-weekday-width"),
			cssPixels(this.contentEl, "--journal-tile-size") + cssPixels(this.contentEl, "--journal-tile-gap"));
		if (fit === null) return;
		const hidden = Math.max(0, this.weeks.length - fit);
		this.firstShown = 0;
		for (const [at, week] of this.weeks.entries()) {
			week.toggleClass("is-clipped", at < hidden);
			if (at < hidden) this.firstShown += week.querySelectorAll("button").length;
		}
		this.contentEl.setCssProps({ "--journal-statistics-weeks": String(this.weeks.length - hidden) });
		this.newWords?.fitYears();
		// Keep the tile reached by Tab among those shown.
		if (this.tiles.findIndex((tile) => tile.button.tabIndex === 0) < this.firstShown) {
			for (const [at, tile] of this.tiles.entries()) tile.button.tabIndex = at === this.firstShown ? 0 : -1;
		}
	}

	private navigateGrid(event: KeyboardEvent, tile: DayTile): void {
		const index = this.tiles.indexOf(tile);
		const destinations: Record<string, number> = {
			ArrowLeft: index - 7, ArrowRight: index + 7, ArrowUp: index - 1, ArrowDown: index + 1,
			Home: this.firstShown, End: this.tiles.length - 1,
		};
		if (!(event.key in destinations)) return;
		event.preventDefault();
		this.tiles[Math.max(this.firstShown, Math.min(this.tiles.length - 1, destinations[event.key]))]?.button.focus();
	}

	private select(tile: DayTile): void {
		for (const candidate of this.tiles) {
			candidate.button.tabIndex = candidate === tile ? 0 : -1;
			candidate.button.toggleClass("is-selected", candidate === tile);
		}
		this.selected = tile;
		this.updateDetail();
	}

	private description(tile: DayTile): string {
		const notes = tile.files.length;
		const count = !notes ? "No note" : !tile.result ? "Counting…" :
			tile.result.status === "error" ? `Could not read ${notes === 1 ? "note" : "a note"}` :
			`${tile.result.words.toLocaleString()} words${notes > 1 ? ` in ${notes} notes` : ""}`;
		return `${tile.date.format("LL")}: ${count}`;
	}

	private updateDetail(): void {
		if (!this.selected) return;
		this.detail.setText(this.description(this.selected));
		this.openButton.hidden = !this.selected.files.length;
	}

	private updateTile(tile: DayTile): void {
		const state = !tile.files.length ? "is-missing" : !tile.result ? "is-loading" :
			tile.result.status === "error" ? "is-error" : `level-${wordCountLevel(tile.result.words)}`;
		tile.button.className = `journal-statistics-tile ${state}${this.selected === tile ? " is-selected" : ""}`;
		const description = this.description(tile);
		tile.button.setAttribute("aria-label", description);
		tile.button.title = description;
		if (this.selected === tile) this.updateDetail();
	}

	private scheduleRefresh(): void {
		if (this.closed) return;
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => void this.refreshCounts(), 200);
	}

	private async refreshCounts(): Promise<void> {
		if (this.closed) return;
		const epoch = ++this.epoch;
		const current = () => !this.closed && this.epoch === epoch;
		this.configSignature = JSON.stringify(this.plugin.daily.config());
		this.plugin.index.ensureCurrent();
		const pending: { tile: DayTile; at: number }[] = [];
		this.paths.clear();
		for (const tile of this.tiles) {
			this.paths.add(this.plugin.daily.pathFor(tile.date));
			tile.files = this.plugin.index
				.pathsFor(tile.date.format(DAY_KEY_FORMAT))
				.map((path) => this.app.vault.getAbstractFileByPath(path))
				.filter((file): file is TFile => file instanceof TFile);
			tile.counts = tile.files.map((file) => this.plugin.statistics.peek(file));
			tile.result = tile.files.length ? combineCounts(tile.counts) : null;
			this.updateTile(tile);
			for (const [at, file] of tile.files.entries()) {
				this.paths.add(file.path);
				if (!tile.counts[at]) pending.push({ tile, at });
			}
		}
		this.grid.setAttribute("aria-busy", String(pending.length > 0));
		this.status.setText(pending.length ? `Counting ${pending.length} notes…` : "");
		let next = 0;
		const worker = async () => {
			while (current() && next < pending.length) {
				const { tile, at } = pending[next++];
				const file = tile.files[at];
				if (!file) continue;
				const result = await this.plugin.statistics.count(file, current);
				if (!current()) return;
				if (result === null) { this.scheduleRefresh(); return; }
				tile.counts[at] = result;
				tile.result = combineCounts(tile.counts);
				this.updateTile(tile);
				// Cached reads may resolve immediately. Yield so progress can paint
				// and navigation can cancel even a year of small, cached files.
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
		};
		await Promise.all([worker(), worker()]);
		if (!current()) return;
		this.grid.setAttribute("aria-busy", "false");
		const notes = this.tiles.reduce((total, tile) => total + tile.files.length, 0);
		const failed = this.tiles.filter((tile) => tile.result?.status === "error").length;
		this.status.setText(failed ? `${notes} notes · ${failed} could not be read. Reopen this year to retry.` :
			`${notes} ${notes === 1 ? "note" : "notes"} in ${this.year}`);
	}
}
