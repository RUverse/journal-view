import { Component, Notice, TFile } from "obsidian";
import type JournalViewPlugin from "./main";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT } from "./noteIndex";
import type { NoteVocabulary } from "./statistics";

/** Words listed for a month before the rest wait behind a button. */
const WORDS_SHOWN = 300;
/** Years always shown, so the mosaic is about as wide as the year mosaic above it. */
const MIN_YEARS = 24;
/** The longest a scan runs between yields to the UI, in milliseconds. */
const YIELD_AFTER = 12;

const wordOrder = new Intl.Collator(undefined, { numeric: true });

interface JournalNote {
	key: string;
	path: string;
	file: TFile;
	month: number;
	/** Null while it is still being read. */
	vocabulary: NoteVocabulary | null;
}

interface MonthTile {
	month: number;
	button: HTMLButtonElement;
	notes: number;
	/** Notes in the month not yet folded in. */
	pending: number;
	failed: number;
	/** Words used for the first time in the month. */
	added: number;
	/** Every word used up to the end of the month. */
	total: number;
}

/** Months counted from year 0, so the month after December is the next January. */
function monthOf(key: string): number {
	return Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
}

function monthMoment(month: number): Moment {
	const year = String(Math.floor(month / 12)).padStart(4, "0");
	return createMoment(`${year}-${String((month % 12) + 1).padStart(2, "0")}-01`, DAY_KEY_FORMAT, true);
}

/**
 * The statistics page's journal-wide mosaic: one tile per month, colored by how
 * many words were used for the first time in it, by note date. Whether a word
 * is new depends on every month before it, so this reads the whole journal,
 * through the shared statistics cache, rather than one year.
 */
export class NewWordsMosaic extends Component {
	private notes: JournalNote[] = [];
	private paths = new Set<string>();
	private tiles = new Map<number, MonthTile>();
	// Indexed by stem id, so every form of a word counts as that one word.
	/** The index in `notes` of the first note using the word, or -1. */
	private first = new Int32Array(0);
	/** The word id of the form it was first written in. */
	private form = new Int32Array(0);
	/** How many notes use the word, among those folded in so far. */
	private uses = new Uint32Array(0);
	/** The last note counted in `uses`, so a note using two forms counts once. */
	private seen = new Int32Array(0);
	/** Notes before this index, all read, are folded into `first` and `uses`. */
	private frontier = 0;
	private epoch = 0;
	private closed = false;
	private refreshTimer = 0;
	private configSignature = "";
	private selected: number | null = null;
	private sort: "uses" | "alphabetical" = "uses";
	private expanded = false;
	private grid!: HTMLElement;
	private legend!: HTMLElement;
	private status!: HTMLElement;
	private detail!: HTMLElement;
	private words!: HTMLElement;

	constructor(private parent: HTMLElement, private plugin: JournalViewPlugin) { super(); }

	onload(): void {
		const heading = this.parent.createDiv({ cls: "journal-statistics-section-heading" });
		heading.createEl("h3", { text: "New words" });
		heading.createEl("p", { text: "Each month, the words your journal had never used before." });
		const card = this.parent.createDiv({ cls: "journal-statistics-card" });
		const scroller = card.createDiv({ cls: "journal-statistics-scroll" });
		this.grid = scroller.createDiv({
			cls: "journal-new-words-grid",
			attr: { role: "group", "aria-label": "New words by month" },
		});
		this.legend = card.createDiv({ cls: "journal-statistics-legend" });
		this.status = card.createDiv({ cls: "journal-statistics-status", attr: { role: "status" } });
		const selection = card.createDiv({ cls: "journal-statistics-selection" });
		this.detail = selection.createSpan({ text: "Select a month to see the words it added.", attr: { "aria-live": "polite" } });
		this.words = card.createDiv({ cls: "journal-new-words-list" });
		this.register(this.plugin.statistics.subscribe((paths, folder) => {
			const relevant = folder
				? paths.some((path) => Array.from(this.paths).some((note) => note.startsWith(`${path}/`)))
				: paths.some((path) => this.paths.has(path) || this.plugin.index.keyForPath(path) !== null);
			if (relevant) this.scheduleRefresh();
		}));
		void this.refresh();
	}

	onunload(): void {
		this.closed = true;
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		this.notes = [];
		this.paths.clear();
		this.tiles.clear();
	}

	onSettingsChanged(): void {
		if (!this.closed && this.configSignature !== JSON.stringify(this.plugin.daily.config())) this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		if (this.closed) return;
		this.epoch++;
		window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => void this.refresh(), 500);
	}

	private async refresh(): Promise<void> {
		if (this.closed) return;
		const epoch = ++this.epoch;
		const current = () => !this.closed && this.epoch === epoch;
		const { index, statistics } = this.plugin;
		this.configSignature = JSON.stringify(this.plugin.daily.config());
		index.ensureCurrent();
		this.notes = [];
		this.paths.clear();
		for (const key of index.keys()) {
			for (const path of index.pathsFor(key)) {
				this.paths.add(path);
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				this.notes.push({ key, path, file, month: monthOf(key), vocabulary: statistics.peekVocabulary(file) });
			}
		}
		this.first = new Int32Array(0);
		this.form = new Int32Array(0);
		this.uses = new Uint32Array(0);
		this.seen = new Int32Array(0);
		this.frontier = 0;
		this.renderGrid();
		this.advance();

		// Read in date order, so the months fill in from the first one onward.
		const pending = this.notes.filter((note) => !note.vocabulary);
		let next = 0;
		let read = 0;
		let lastYield = performance.now();
		const worker = async () => {
			while (current() && next < pending.length) {
				const note = pending[next++];
				const result = await statistics.vocabulary(note.file, current);
				if (!current()) return;
				if (result === null) { this.scheduleRefresh(); return; }
				note.vocabulary = result;
				read++;
				// Cached reads may resolve immediately. Yield now and then so the
				// tiles can paint and a refresh can cancel even a long scan.
				if (performance.now() - lastYield > YIELD_AFTER) {
					this.advance();
					this.status.setText(`Reading ${read.toLocaleString()} of ${pending.length.toLocaleString()} notes…`);
					await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
					lastYield = performance.now();
				}
			}
		};
		if (pending.length) this.status.setText(`Reading ${pending.length.toLocaleString()} notes…`);
		await Promise.all([worker(), worker()]);
		if (!current()) return;
		this.advance();
		const failed = this.notes.filter((note) => note.vocabulary?.status === "error").length;
		const distinct = this.first.reduce((total, note) => total + (note >= 0 ? 1 : 0), 0);
		this.status.setText(!this.notes.length ? "No daily notes yet." :
			`${distinct.toLocaleString()} distinct words in ${this.notes.length.toLocaleString()} ` +
			`${this.notes.length === 1 ? "note" : "notes"}` +
			(failed ? ` · ${failed} could not be read. Reopen statistics to retry.` : ""));
		this.renderWords();
	}

	/** Folds in every note read, up to the first one still being read, and repaints the tiles. */
	private advance(): void {
		const start = this.frontier;
		const { statistics } = this.plugin;
		this.reserve(statistics.stemCount);
		for (; this.frontier < this.notes.length; this.frontier++) {
			const note = this.notes[this.frontier];
			if (!note.vocabulary) break;
			const tile = this.tiles.get(note.month);
			if (tile) tile.pending--;
			if (note.vocabulary.status === "error") {
				if (tile) tile.failed++;
				continue;
			}
			// A note's words come in the order it first writes them, so the form
			// kept is the one written first.
			for (const id of note.vocabulary.ids) {
				const stem = statistics.stemOf(id);
				if (this.first[stem] < 0) {
					this.first[stem] = this.frontier;
					this.form[stem] = id;
					if (tile) tile.added++;
				}
				if (this.seen[stem] !== this.frontier) {
					this.seen[stem] = this.frontier;
					this.uses[stem]++;
				}
			}
		}
		if (this.frontier !== start || start === 0) this.updateTiles();
	}

	private reserve(size: number): void {
		if (size <= this.first.length) return;
		const length = Math.max(size, this.first.length * 2, 1024);
		const grow = <T extends Int32Array | Uint32Array>(old: T, next: T): T => {
			next.set(old);
			return next;
		};
		this.first = grow(this.first, new Int32Array(length).fill(-1));
		this.form = grow(this.form, new Int32Array(length));
		this.uses = grow(this.uses, new Uint32Array(length));
		this.seen = grow(this.seen, new Int32Array(length).fill(-1));
	}

	private renderGrid(): void {
		const focused = this.grid.doc.activeElement;
		const refocus = focused instanceof HTMLElement && this.grid.contains(focused) ? Number(focused.dataset.month) : null;
		this.grid.empty();
		this.tiles.clear();
		// Laid out in columns, like the year mosaic: a column of month names,
		// then one column per year, so later is always down or to the right.
		// Every year through this one is shown, and empty years before the
		// journal pad a short one out to the year mosaic's width.
		const thisMonth = monthOf(createMoment().format(DAY_KEY_FORMAT));
		const lastYear = Math.max(Math.floor(thisMonth / 12), Math.floor((this.notes[this.notes.length - 1]?.month ?? 0) / 12));
		const firstYear = Math.max(1, Math.min(Math.floor((this.notes[0]?.month ?? thisMonth) / 12), lastYear - MIN_YEARS + 1));
		this.grid.createSpan();
		for (let month = 0; month < 12; month++) {
			this.grid.createSpan({ cls: "journal-new-words-label is-month", text: monthMoment(month).format("MMM"), attr: { "aria-hidden": "true" } });
		}
		for (let year = firstYear; year <= lastYear; year++) {
			this.grid.createSpan({ cls: "journal-new-words-label is-year", text: String(year), attr: { "aria-hidden": "true" } });
			for (let month = year * 12; month < year * 12 + 12; month++) {
				const button = this.grid.createEl("button", {
					cls: "journal-statistics-tile is-loading",
					attr: { "data-month": String(month), tabindex: "-1" },
				});
				if (month === thisMonth) button.setAttribute("aria-current", "date");
				const tile: MonthTile = { month, button, notes: 0, pending: 0, failed: 0, added: 0, total: 0 };
				this.tiles.set(month, tile);
				button.addEventListener("click", () => this.select(month));
				button.addEventListener("focus", () => this.select(month));
				button.addEventListener("keydown", (event) => this.navigateGrid(event, month));
			}
		}
		for (const note of this.notes) {
			const tile = this.tiles.get(note.month);
			if (tile) { tile.notes++; tile.pending++; }
		}
		if (this.selected !== null && !this.tiles.has(this.selected)) this.selected = null;
		const roving = this.tiles.get(this.selected ?? this.notes[this.notes.length - 1]?.month ?? thisMonth);
		if (roving) roving.button.tabIndex = 0;
		if (refocus !== null) this.tiles.get(refocus)?.button.focus();
	}

	private navigateGrid(event: KeyboardEvent, month: number): void {
		const months = Array.from(this.tiles.keys());
		const destinations: Record<string, number> = {
			ArrowLeft: month - 12, ArrowRight: month + 12, ArrowUp: month - 1, ArrowDown: month + 1,
			Home: months[0], End: months[months.length - 1],
		};
		if (!(event.key in destinations)) return;
		event.preventDefault();
		this.tiles.get(destinations[event.key])?.button.focus();
	}

	private select(month: number): void {
		if (this.selected !== month) this.expanded = false;
		this.selected = month;
		for (const tile of this.tiles.values()) {
			tile.button.tabIndex = tile.month === month ? 0 : -1;
			tile.button.toggleClass("is-selected", tile.month === month);
		}
		this.updateDetail();
		this.renderWords();
	}

	private description(tile: MonthTile): string {
		const name = monthMoment(tile.month).format("MMMM YYYY");
		if (!tile.notes) return `${name}: No notes`;
		if (tile.pending) return `${name}: Reading…`;
		const failed = tile.failed ? ` · ${tile.failed === 1 ? "a note" : `${tile.failed} notes`} could not be read` : "";
		return `${name}: ${tile.added.toLocaleString()} new ${tile.added === 1 ? "word" : "words"}` +
			` · ${tile.total.toLocaleString()} in your journal so far${failed}`;
	}

	private updateDetail(): void {
		const tile = this.selected === null ? undefined : this.tiles.get(this.selected);
		if (tile) this.detail.setText(this.description(tile));
	}

	/**
	 * Colors each finished month by its rank among the months that added any
	 * words, in quarters. The first months of a journal add far more than the
	 * rest, and a fixed scale would leave every later month the same pale shade.
	 */
	private updateTiles(): void {
		const counts: number[] = [];
		let total = 0;
		for (const tile of this.tiles.values()) {
			if (tile.pending) break;
			total += tile.added;
			tile.total = total;
			if (tile.added) counts.push(tile.added);
		}
		counts.sort((left, right) => left - right);
		const level = (added: number): number => {
			if (!added) return 0;
			let low = 0;
			let high = counts.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (counts[mid] <= added) low = mid + 1;
				else high = mid;
			}
			return Math.max(1, Math.ceil((4 * low) / counts.length));
		};
		for (const tile of this.tiles.values()) {
			const state = !tile.notes ? "is-missing" : tile.pending ? "is-loading" :
				tile.failed ? "is-error" : `level-${level(tile.added)}`;
			tile.button.className = `journal-statistics-tile ${state}${this.selected === tile.month ? " is-selected" : ""}`;
			const description = this.description(tile);
			tile.button.setAttribute("aria-label", description);
			tile.button.title = description;
		}
		this.updateDetail();

		const ranges: { min: number; max: number }[] = [];
		for (const added of counts) {
			const range = ranges[level(added)] ??= { min: added, max: added };
			range.max = added;
		}
		this.legend.empty();
		this.legendItem(0, "No note / no new words");
		for (let at = 1; at < ranges.length; at++) {
			const range = ranges[at];
			if (!range) continue;
			const { min, max } = range;
			this.legendItem(at, at === ranges.length - 1 ? `${min.toLocaleString()}+` :
				min === max ? min.toLocaleString() : `${min.toLocaleString()}–${max.toLocaleString()}`);
		}
	}

	private legendItem(level: number, label: string): void {
		const item = this.legend.createSpan();
		item.createSpan({ cls: `journal-statistics-swatch level-${level}`, attr: { "aria-hidden": "true" } });
		item.createSpan({ text: label });
	}

	/** Lists the selected month's new words, once the whole journal has been read. */
	private renderWords(): void {
		this.words.empty();
		const tile = this.selected === null ? undefined : this.tiles.get(this.selected);
		if (!tile?.notes) return;
		if (this.frontier < this.notes.length) {
			this.words.createDiv({ cls: "journal-new-words-note", text: "The words appear once the whole journal has been read." });
			return;
		}
		const stems: number[] = [];
		for (let stem = 0; stem < this.first.length; stem++) {
			if (this.first[stem] >= 0 && this.notes[this.first[stem]].month === tile.month) stems.push(stem);
		}
		if (!stems.length) return;
		const { statistics } = this.plugin;
		const shownAs = (stem: number) => statistics.word(this.form[stem]);
		stems.sort(this.sort === "uses"
			? (left, right) => this.uses[right] - this.uses[left] || wordOrder.compare(shownAs(left), shownAs(right))
			: (left, right) => wordOrder.compare(shownAs(left), shownAs(right)));
		const shown = this.expanded ? stems : stems.slice(0, WORDS_SHOWN);
		const forms = this.otherForms(new Set(shown));

		const header = this.words.createDiv({ cls: "journal-new-words-header" });
		header.createSpan({ text: "Click a word to open the note that first used it." });
		const sort = header.createEl("select", { cls: "dropdown", attr: { "aria-label": "Sort words" } });
		sort.createEl("option", { text: "Most used", value: "uses" });
		sort.createEl("option", { text: "Alphabetical", value: "alphabetical" });
		sort.value = this.sort;
		sort.addEventListener("change", () => {
			this.sort = sort.value === "alphabetical" ? "alphabetical" : "uses";
			this.renderWords();
		});

		const list = this.words.createDiv({ cls: "journal-new-words-words" });
		for (const stem of shown) {
			const word = shownAs(stem);
			const note = this.notes[this.first[stem]];
			const date = createMoment(note.key, DAY_KEY_FORMAT, true);
			const uses = this.uses[stem];
			const also = forms.get(stem);
			const label = `${word}${also ? ` (also ${Array.from(also).sort((left, right) => wordOrder.compare(left, right)).join(", ")})` : ""}: ` +
				`first used on ${date.format("LL")}, in ${uses.toLocaleString()} ${uses === 1 ? "note" : "notes"}`;
			const button = list.createEl("button", { cls: "journal-new-words-word", text: word, attr: { "aria-label": label } });
			button.title = label;
			button.addEventListener("click", () => this.open(note.key, note.path));
		}
		if (shown.length < stems.length) {
			const more = this.words.createEl("button", { cls: "journal-new-words-more", text: `Show all ${stems.length.toLocaleString()} words` });
			more.addEventListener("click", () => {
				this.expanded = true;
				this.renderWords();
			});
		}
	}

	/** The forms of each of `stems` used anywhere in the journal, beyond the one shown. */
	private otherForms(stems: Set<number>): Map<number, Set<string>> {
		const { statistics } = this.plugin;
		const forms = new Map<number, Set<string>>();
		for (const note of this.notes) {
			if (note.vocabulary?.status !== "ready") continue;
			for (const id of note.vocabulary.ids) {
				const stem = statistics.stemOf(id);
				if (!stems.has(stem) || id === this.form[stem]) continue;
				let set = forms.get(stem);
				if (!set) forms.set(stem, set = new Set());
				set.add(statistics.word(id));
			}
		}
		return forms;
	}

	private open(key: string, path: string): void {
		if (!this.plugin.index.has(key)) return;
		const date = createMoment(key, DAY_KEY_FORMAT, true);
		void this.plugin.activateView(false, date, false, true, path).catch((error: unknown) => {
			console.error("Journal View: could not open the note that first used a word", error);
			new Notice("Could not open this journal entry.");
		});
	}
}
