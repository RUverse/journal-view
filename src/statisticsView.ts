import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import type JournalViewPlugin from "./main";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT } from "./noteIndex";
import { NoteStatistics, wordCountLevel } from "./statistics";

export const VIEW_TYPE_STATISTICS = "journal-statistics";

interface DayTile {
	date: Moment;
	button: HTMLButtonElement;
	file: TFile | null;
	result: NoteStatistics | null;
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
	private grid!: HTMLElement;
	private status!: HTMLElement;
	private detail!: HTMLElement;
	private openButton!: HTMLButtonElement;
	private selected: DayTile | null = null;

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
		const scroller = card.createDiv({ cls: "journal-statistics-scroll" });
		this.grid = scroller.createDiv({ cls: "journal-statistics-grid", attr: { role: "group", "aria-label": "Daily note word counts" } });
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
			if (!tile?.file || !this.plugin.daily.fileFor(tile.date)) return;
			void this.plugin.activateView(false, tile.date, false, true).catch((error: unknown) => {
				console.error("Journal View: could not open statistics entry", error);
				new Notice("Could not open this journal entry.");
			});
		});
		this.register(this.plugin.statistics.subscribe((paths, folder) => {
			const relevant = folder
				? paths.some((path) => Array.from(this.paths).some((note) => note.startsWith(`${path}/`)))
				: paths.some((path) => this.paths.has(path));
			if (relevant) this.scheduleRefresh();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onSettingsChanged()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onSettingsChanged()));
		this.renderYear();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		this.tiles = [];
		this.paths.clear();
		this.selected = null;
	}

	onSettingsChanged(): void {
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
				const tile: DayTile = { date: cursor.clone(), button, file: null, result: null };
				this.tiles.push(tile);
				button.addEventListener("click", () => this.select(tile));
				button.addEventListener("focus", () => this.select(tile));
				button.addEventListener("keydown", (event) => this.navigateGrid(event, tile));
			}
		}
		const initial = this.tiles.find((tile) => tile.date.format(DAY_KEY_FORMAT) === today) ?? this.tiles[0];
		if (initial) initial.button.tabIndex = 0;
		void this.refreshCounts();
	}

	private navigateGrid(event: KeyboardEvent, tile: DayTile): void {
		const index = this.tiles.indexOf(tile);
		const destinations: Record<string, number> = {
			ArrowLeft: index - 7, ArrowRight: index + 7, ArrowUp: index - 1, ArrowDown: index + 1,
			Home: 0, End: this.tiles.length - 1,
		};
		if (!(event.key in destinations)) return;
		event.preventDefault();
		this.tiles[Math.max(0, Math.min(this.tiles.length - 1, destinations[event.key]))]?.button.focus();
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
		const count = !tile.file ? "No note" : !tile.result ? "Counting…" :
			tile.result.status === "error" ? "Could not read note" : `${tile.result.words.toLocaleString()} words`;
		return `${tile.date.format("LL")}: ${count}`;
	}

	private updateDetail(): void {
		if (!this.selected) return;
		this.detail.setText(this.description(this.selected));
		this.openButton.hidden = !this.selected.file;
	}

	private updateTile(tile: DayTile): void {
		const state = !tile.file ? "is-missing" : !tile.result ? "is-loading" :
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
		const pending: DayTile[] = [];
		this.paths.clear();
		for (const tile of this.tiles) {
			this.paths.add(this.plugin.daily.pathFor(tile.date));
			tile.file = this.plugin.daily.fileFor(tile.date);
			tile.result = tile.file ? this.plugin.statistics.peek(tile.file) : null;
			this.updateTile(tile);
			if (tile.file && !tile.result) pending.push(tile);
		}
		this.grid.setAttribute("aria-busy", String(pending.length > 0));
		this.status.setText(pending.length ? `Counting ${pending.length} notes…` : "");
		let next = 0;
		const worker = async () => {
			while (current() && next < pending.length) {
				const tile = pending[next++];
				if (!tile.file) continue;
				const result = await this.plugin.statistics.count(tile.file, current);
				if (!current()) return;
				if (result === null) { this.scheduleRefresh(); return; }
				tile.result = result;
				this.updateTile(tile);
				// Cached reads may resolve immediately. Yield so progress can paint
				// and navigation can cancel even a year of small, cached files.
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
		};
		await Promise.all([worker(), worker()]);
		if (!current()) return;
		this.grid.setAttribute("aria-busy", "false");
		const notes = this.tiles.filter((tile) => tile.file).length;
		const failed = this.tiles.filter((tile) => tile.result?.status === "error").length;
		this.status.setText(failed ? `${notes} notes · ${failed} could not be read. Reopen this year to retry.` :
			`${notes} ${notes === 1 ? "note" : "notes"} in ${this.year}`);
	}
}
