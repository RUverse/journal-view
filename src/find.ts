import { App, TFile, setIcon, setTooltip } from "obsidian";
import type JournalViewPlugin from "./main";
import type { DaySection } from "./day";
import type { NoteEntry } from "./entry";
import { MAX_OFFSET } from "./dayWalk";
import { countMatches, literalExpression, rangesOf } from "./findText";
import type { FindRange } from "./findText";
import { FindResults } from "./findResults";
import type { FindPosition } from "./findResults";
import { DAY_KEY_FORMAT } from "./noteIndex";
import { createMoment } from "./moment";
import type { Moment } from "./moment";

/** Time a search spends counting before it lets the window paint and take input (ms). */
const SLICE_BUDGET = 8;
/** Notes read at once ahead of a search, so it is not waiting on one file at a time. */
const READ_AHEAD = 6;
/** How far past the search, in days, reading ahead looks for notes not read yet. */
const READ_AHEAD_DAYS = READ_AHEAD * 4;
/** Quiet time after typing before find travels to a day that is not loaded (ms). */
const JUMP_DELAY = 300;

/** Uses the first icon available in the reader's Obsidian/Lucide build. */
function applyIcon(el: HTMLElement, ...names: string[]): void {
	for (const name of names) {
		setIcon(el, name);
		if (el.querySelector("svg")) return;
		el.empty();
	}
}

function sameReach(left: FindPass["reach"], right: FindPass["reach"]): boolean {
	return left === right || (!!left && !!right && left.first === right.first && left.last === right.last);
}

/** A note of a loaded day, searched in the text its editor holds right now. */
interface LiveNote {
	section: DaySection;
	entry: NoteEntry;
	key: string;
	/** Where the note sits within its day. */
	order: number;
	ranges: FindRange[];
}

/** The selected match. `from` and `to` are -1 while its day is not loaded. */
interface FindSelection extends FindPosition, FindRange {}

/** Where a search starts: a day, and in it a note's `order` and an offset. */
interface FindAnchor {
	key: string;
	order: number;
	from: number;
}

/**
 * One search of the whole journal for one query. It walks every day once,
 * outward from the anchor and nearest days first, so the match nearest the
 * reader is settled as soon as the walk reaches it, and stays settled. The
 * days it has counted always run unbroken around the anchor.
 */
interface FindPass {
	query: string;
	expression: RegExp;
	step: -1 | 1;
	/** The anchor's day, then every other day with notes the filters let in, nearest first. */
	keys: string[];
	ranks: Map<string, number>;
	/** How many of `keys` have been counted. */
	frontier: number;
	done: boolean;
	generation: number;
	anchor: FindAnchor;
	/** Still to pick the match nearest the anchor, and whether to bring it into view. */
	choosing: boolean;
	reveal: boolean;
	/** Dates outside these are out of the view's reach; null when every date is in it. */
	reach: { first: string; last: string } | null;
	indexVersion: number;
	filterVersion: number;
	/** Reads started ahead of the walk, by path. */
	reads: Map<string, Promise<string | null>>;
}

export interface JournalFindHost {
	readonly app: App;
	readonly plugin: JournalViewPlugin;
	readonly sections: DaySection[];
	sortStep(): -1 | 1;
	setFindMode(open: boolean): void;
	findAnchorSection(previous?: DaySection | null): DaySection | null;
	revealFindMatch(section: DaySection, entry: NoteEntry, range: FindRange): void;
	loadFindDate(date: Moment): Promise<void>;
	isFindReady(): boolean;
}

/**
 * Owns the find bar and searches the whole journal for it. The count and the
 * order of results cover every note the filters let in, not just the days
 * that happen to be loaded: loaded days are searched in the text their
 * editors hold, every other note through the plugin's shared `FindCorpus`.
 */
export class JournalFind {
	private readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly countEl: HTMLElement;
	private readonly previousButton: HTMLButtonElement;
	private readonly nextButton: HTMLButtonElement;
	private readonly caseButton: HTMLButtonElement;
	private readonly closeButton: HTMLButtonElement;

	private open = false;
	private caseSensitive = false;
	private results = new FindResults();
	/** The notes of the loaded days, by path, in timeline order. */
	private live = new Map<string, LiveNote>();
	private liveKeys = new Set<string>();
	private selected: FindSelection | null = null;
	private pass: FindPass | null = null;
	private generation = 0;
	/** Work waiting for the next frame: a new search, or the loaded days changed. */
	private pending = { search: false, live: false };
	/** Notes that changed in the vault since the last frame. */
	private changedPaths = new Set<string>();
	private frame = 0;
	private countFrame = 0;
	private jumpTimer = 0;
	private lastInputAt = 0;
	/** Enter pressed before the walk could tell which match comes next. */
	private navigation: -1 | 0 | 1 = 0;
	private navigationToken = 0;
	/** True while the view loads the day of the match being travelled to. */
	private travelling = false;
	/** The day focus last came to the find bar from, so a search starts where the reader was. */
	private cameFrom: DaySection | null = null;
	private releaseCorpus: (() => void) | null = null;
	private unsubscribe: (() => void) | null = null;
	private destroyed = false;

	constructor(parent: HTMLElement, private host: JournalFindHost) {
		this.el = parent.createDiv({ cls: "journal-find-bar is-hidden" });
		const inputWrap = this.el.createDiv({ cls: "journal-find-input-wrap" });
		const searchIcon = inputWrap.createSpan({ cls: "journal-find-search-icon" });
		setIcon(searchIcon, "search");
		this.input = inputWrap.createEl("input", {
			cls: "journal-find-input",
			attr: { type: "text", placeholder: "Find…", "aria-label": "Find in journal", autocomplete: "off" },
		});
		this.countEl = inputWrap.createSpan({ cls: "journal-find-count", attr: { "aria-live": "polite" } });

		this.previousButton = this.iconButton(["arrow-up"], "Previous result", () => this.navigate(-1));
		this.nextButton = this.iconButton(["arrow-down"], "Next result", () => this.navigate(1));
		this.caseButton = this.iconButton(["case-sensitive", "type"], "Match case", () => this.toggleCase());
		this.closeButton = this.iconButton(["x"], "Close find", () => this.close());

		this.input.addEventListener("focus", (event) => this.focusCameFrom(event.relatedTarget as Node | null));
		this.input.addEventListener("input", () => this.queryChanged());
		this.input.addEventListener("keydown", (event) => this.onInputKeydown(event));
		this.updateButtons();
	}

	private iconButton(icons: string[], label: string, action: () => void): HTMLButtonElement {
		const button = this.el.createEl("button", { cls: "clickable-icon journal-find-button" });
		applyIcon(button, ...icons);
		setTooltip(button, label);
		button.setAttribute("aria-label", label);
		button.addEventListener("click", action);
		return button;
	}

	show(): void {
		if (this.destroyed) return;
		if (!this.open) {
			this.open = true;
			this.el.removeClass("is-hidden");
			this.host.setFindMode(true);
			const corpus = this.host.plugin.findCorpus;
			this.releaseCorpus = corpus.retain();
			this.unsubscribe = corpus.subscribe((paths) => this.filesChanged(paths));
			this.lastInputAt = 0;
			this.schedule("search");
		}
		this.focusInput(true);
	}

	close(): void {
		if (!this.open) return;
		this.open = false;
		this.el.addClass("is-hidden");
		this.host.setFindMode(false);
		const selected = this.selected ? this.live.get(this.selected.path)?.entry : undefined;
		this.reset();
		this.updateCount();
		this.updateButtons();
		if (selected?.el.isConnected) selected.focusEditor();
	}

	isOpen(): boolean {
		return this.open;
	}

	/** Handles Escape early enough to outrank Obsidian's workspace keymap. */
	handleEscape(event: KeyboardEvent): boolean {
		const target = event.target as Node | null;
		if (!this.open || !target || !this.el.contains(target)) return false;
		this.close();
		return true;
	}

	focusInput(select = false): void {
		this.input.focus({ preventScroll: true });
		if (select) this.input.select();
	}

	private focusCameFrom(from: Node | null): void {
		const section = this.host.sections.find((candidate) => candidate.el.contains(from));
		if (section) this.cameFrom = section;
	}

	/** Searches the loaded days again after they, or what they hold, changed. */
	sectionsChanged(): void {
		if (this.open) this.schedule("live");
	}

	private queryChanged(): void {
		this.lastInputAt = performance.now();
		this.schedule("search");
	}

	private filesChanged(paths: string[]): void {
		if (!this.open || !this.pass) return;
		for (const path of paths) this.changedPaths.add(path);
		this.schedule();
	}

	private schedule(kind?: "search" | "live"): void {
		if (kind) this.pending[kind] = true;
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			this.flush();
		});
	}

	/**
	 * Does what the last frame asked for. A view that is still being built
	 * calls `sectionsChanged` once it is done, which comes back here.
	 */
	private flush(): void {
		if (!this.open || !this.host.isFindReady()) return;
		const { search, live } = this.pending;
		this.pending = { search: false, live: false };
		const { plugin } = this.host;
		plugin.filteredIndex.ensureCurrent();
		const pass = this.pass;
		if (search) {
			this.start(true);
		} else if (!pass) {
			if (live) this.syncLive();
		} else if (
			pass.indexVersion !== plugin.index.version ||
			pass.filterVersion !== plugin.filteredIndex.version ||
			pass.step !== this.host.sortStep() ||
			!sameReach(pass.reach, this.reach())
		) {
			// Notes came or went, the filters let in others, the timeline
			// turned around, or a different span of it is in reach: count the
			// journal again, keeping the selection.
			this.start(false);
		} else {
			if (live) this.syncLive();
			for (const path of this.changedPaths) void this.recount(path);
			this.changedPaths.clear();
			this.progress(pass);
		}
	}

	/**
	 * Starts a walk of the journal. A `fresh` one is for a new query: it drops
	 * the old results and picks the match nearest the reader. Otherwise
	 * every note is counted again in place, so the count does not blink.
	 */
	private start(fresh: boolean): void {
		const { plugin } = this.host;
		const query = this.input.value;
		const expression = literalExpression(query, this.caseSensitive);
		const previous = this.pass;
		this.changedPaths.clear();
		let anchor = this.readerAnchor();
		let choosing = fresh;
		let reveal = fresh;
		if (fresh) {
			anchor = this.selectionAnchor() ?? anchor;
			this.navigationToken++;
			this.navigation = 0;
			this.travelling = false;
			this.cancelJump();
			this.results.clear();
			this.selected = null;
		} else if (previous?.choosing) {
			({ anchor, choosing, reveal } = previous);
		}

		if (!expression) {
			this.pass = null;
			this.results.clear();
			this.selected = null;
			this.syncLive();
			this.updateCount();
			this.updateButtons();
			return;
		}

		const step = this.host.sortStep();
		const keys = [anchor.key, ...plugin.filteredIndex.keysAround(anchor.key, step)];
		const pass: FindPass = {
			query,
			expression,
			step,
			keys,
			ranks: new Map(keys.map((key, index) => [key, index])),
			frontier: 0,
			done: false,
			generation: ++this.generation,
			anchor,
			choosing,
			reveal,
			reach: this.reach(),
			indexVersion: plugin.index.version,
			filterVersion: plugin.filteredIndex.version,
			reads: new Map(),
		};
		this.pass = pass;
		this.syncLive();
		this.updateButtons();
		void this.walk(pass);
	}

	/** Where a new query starts: the selected match while its day is loaded. */
	private selectionAnchor(): FindAnchor | null {
		const selected = this.selected;
		const note = selected && selected.from >= 0 ? this.live.get(selected.path) : undefined;
		if (!selected || !note?.entry.el.isConnected) return null;
		return { key: note.key, order: note.order, from: selected.from };
	}

	/** The start of the day the reader is on. */
	private readerAnchor(): FindAnchor {
		const section = this.host.findAnchorSection(this.cameFrom);
		return { key: section?.key ?? createMoment().format(DAY_KEY_FORMAT), order: -1, from: 0 };
	}

	/**
	 * The dates the view can travel to. With empty days shown it walks the
	 * calendar, so a note further away than that walk goes is out of reach -
	 * the same limit `isOffsetReachable` sets for an indexed day.
	 */
	private reach(): FindPass["reach"] {
		if (this.host.plugin.settings.hideEmptyDays) return null;
		const today = createMoment().startOf("day");
		return {
			first: today.clone().subtract(MAX_OFFSET, "days").format(DAY_KEY_FORMAT),
			last: today.clone().add(MAX_OFFSET, "days").format(DAY_KEY_FORMAT),
		};
	}

	private reachable(pass: FindPass, key: string): boolean {
		return !pass.reach || (key >= pass.reach.first && key <= pass.reach.last);
	}

	/**
	 * Searches the loaded days in the text their editors hold right now, and
	 * marks their matches. Notes that left the loaded days keep their last
	 * count until the walk, or a change in the vault, counts them again.
	 */
	private syncLive(): void {
		const pass = this.pass;
		const live = new Map<string, LiveNote>();
		const liveKeys = new Set<string>();
		for (const section of this.host.sections) {
			liveKeys.add(section.key);
			section.entries.forEach((entry, order) => {
				const ranges =
					pass && !section.isHidden && !entry.isHidden ? rangesOf(entry.searchText(), pass.expression) : [];
				live.set(entry.path, { section, entry, key: section.key, order, ranges });
				if (pass) this.results.set(section.key, entry.path, order, ranges.length, pass.generation);
			});
		}
		this.live = live;
		this.liveKeys = liveKeys;
		this.syncSelection();

		const query = pass?.query ?? "";
		const selected = this.selected;
		for (const note of live.values()) {
			const range =
				selected && selected.path === note.entry.path && selected.from >= 0
					? { from: selected.from, to: selected.to }
					: null;
			note.entry.setFindState(query, this.caseSensitive, note.ranges, range);
			if (!range) note.entry.selectFindRange(null);
		}
		this.scheduleCount();
	}

	/** Keeps the selection on the same match after its note was searched again. */
	private syncSelection(): void {
		const selected = this.selected;
		if (!selected) return;
		const note = this.live.get(selected.path);
		if (note) {
			const { ranges } = note;
			let index = -1;
			if (selected.from >= 0) {
				index = ranges.findIndex((range) => range.from === selected.from);
				if (index < 0) index = ranges.findIndex((range) => range.from > selected.from);
			}
			if (index < 0) index = Math.min(selected.index, ranges.length - 1);
			const range = ranges[index];
			this.selected = range ? { key: note.key, path: selected.path, index, from: range.from, to: range.to } : null;
			return;
		}
		const counted = this.results.note(selected.path);
		if (!counted) this.selected = null;
		else if (selected.index >= counted.count) {
			this.selected = { key: counted.key, path: selected.path, index: counted.count - 1, from: -1, to: -1 };
		}
	}

	/**
	 * Counts the notes of every day that is not loaded, in walk order. Notes
	 * already read are counted in slices of a few milliseconds; the rest are
	 * read a few at a time just ahead of the walk, and counted in order.
	 */
	private async walk(pass: FindPass): Promise<void> {
		const { app, plugin } = this.host;
		const corpus = plugin.findCorpus;
		let deadline = performance.now() + SLICE_BUDGET;
		while (pass.frontier < pass.keys.length) {
			const key = pass.keys[pass.frontier];
			if (!this.liveKeys.has(key) && this.reachable(pass, key)) {
				const paths = plugin.index.pathsFor(key);
				for (let order = 0; order < paths.length; order++) {
					const path = paths[order];
					if (this.live.has(path) || !plugin.filteredIndex.matchesPath(path)) continue;
					const file = app.vault.getAbstractFileByPath(path);
					if (!(file instanceof TFile)) continue;
					let text = corpus.peek(file);
					if (text === null) {
						this.readAhead(pass);
						const read = pass.reads.get(path) ?? corpus.read(file);
						pass.reads.delete(path);
						text = await read;
						if (pass !== this.pass) return;
						// Waiting on the read already let the window take input.
						deadline = performance.now() + SLICE_BUDGET;
						if (this.live.has(path)) continue;
					}
					const count = text === null ? 0 : countMatches(text, pass.expression);
					this.results.set(key, path, order, count, pass.generation);
				}
			}
			pass.frontier++;
			this.progress(pass);
			if (pass !== this.pass) return;
			if (performance.now() >= deadline) {
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
				if (pass !== this.pass) return;
				deadline = performance.now() + SLICE_BUDGET;
			}
		}
		pass.done = true;
		pass.reads.clear();
		this.results.prune(pass.generation);
		this.syncSelection();
		this.progress(pass);
		this.updateButtons();
	}

	/** Starts reading the notes just ahead of the walk that are not cached yet. */
	private readAhead(pass: FindPass): void {
		const { app, plugin } = this.host;
		const corpus = plugin.findCorpus;
		const end = Math.min(pass.keys.length, pass.frontier + READ_AHEAD_DAYS);
		for (let at = pass.frontier; at < end && pass.reads.size < READ_AHEAD; at++) {
			const key = pass.keys[at];
			if (this.liveKeys.has(key) || !this.reachable(pass, key)) continue;
			for (const path of plugin.index.pathsFor(key)) {
				if (pass.reads.size >= READ_AHEAD) return;
				if (pass.reads.has(path) || this.live.has(path) || !plugin.filteredIndex.matchesPath(path)) continue;
				const file = app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile) || corpus.peek(file) !== null) continue;
				const read = corpus.read(file);
				pass.reads.set(path, read);
				// A finished read is in the cache, where the walk will find it;
				// only reads still under way hold one of the slots.
				void read.finally(() => {
					if (pass.reads.get(path) === read) pass.reads.delete(path);
				});
			}
		}
	}

	/** Counts one note again after it changed in the vault. */
	private async recount(path: string): Promise<void> {
		const pass = this.pass;
		if (!pass || this.live.has(path)) return;
		const { app, plugin } = this.host;
		const file = app.vault.getAbstractFileByPath(path);
		const key = file instanceof TFile ? plugin.index.keyForPath(path) : null;
		if (!(file instanceof TFile) || !key || !plugin.filteredIndex.matchesPath(path) || !this.reachable(pass, key)) {
			this.results.delete(path);
			this.syncSelection();
			this.progress(pass);
			return;
		}
		const text = await plugin.findCorpus.read(file);
		if (pass !== this.pass || this.live.has(path)) return;
		const order = plugin.index.pathsFor(key).indexOf(path);
		const count = text === null ? 0 : countMatches(text, pass.expression);
		this.results.set(key, path, order, count, pass.generation);
		this.syncSelection();
		this.progress(pass);
	}

	/** Acts on whatever the walk has settled since the last step. */
	private progress(pass: FindPass): void {
		if (pass !== this.pass) return;
		if (pass.choosing) this.choose(pass);
		if (this.navigation) this.resolveNavigation();
		this.scheduleCount();
	}

	/** Selects the match nearest the anchor once the walk has settled which one it is. */
	private choose(pass: FindPass): void {
		const nearest = this.nearestToAnchor(pass);
		if (nearest === undefined) return;
		pass.choosing = false;
		if (!nearest) {
			this.select(null, false);
			return;
		}
		const note = this.live.get(nearest.path);
		if (note) {
			this.select(this.selectionIn(note, nearest.index), pass.reveal);
			return;
		}
		this.select({ ...nearest, from: -1, to: -1 }, false);
		if (pass.reveal) this.scheduleJump();
	}

	/**
	 * The match nearest the anchor: on its own day, the first from the anchor
	 * on, or else the last before it; otherwise the closest match on the
	 * nearest day with any, on either side. Null when there is none, undefined
	 * until settled.
	 */
	private nearestToAnchor(pass: FindPass): FindPosition | null | undefined {
		const { anchor, step } = pass;
		// The anchor's day is loaded, so its matches are known already.
		let earlier: FindPosition | null = null;
		for (const note of this.live.values()) {
			if (note.key !== anchor.key || !note.ranges.length) continue;
			const index =
				note.order === anchor.order
					? note.ranges.findIndex((range) => range.from >= anchor.from)
					: note.order > anchor.order
						? 0
						: -1;
			if (index >= 0) return { key: anchor.key, path: note.entry.path, index };
			earlier = { key: anchor.key, path: note.entry.path, index: note.ranges.length - 1 };
		}
		if (earlier) return earlier;
		let nearest = this.results.first(anchor.key);
		if (!nearest) {
			const below = this.results.nextKey(anchor.key, step);
			const above = this.results.nextKey(anchor.key, (-step) as -1 | 1);
			// The walk reaches days nearest first, so the nearer one ranks first.
			if (below && (!above || this.rank(pass, below) <= this.rank(pass, above))) nearest = this.results.first(below);
			else if (above) nearest = this.results.last(above);
		}
		if (!nearest) return pass.done ? null : undefined;
		return this.settled(pass, nearest) ? nearest : undefined;
	}

	/** Where `key` falls in the pass's walk. */
	private rank(pass: FindPass, key: string): number {
		return pass.ranks.get(key) ?? Infinity;
	}

	/** True once the walk has counted `at`'s day, and every day nearer the anchor. */
	private settled(pass: FindPass, at: FindPosition): boolean {
		return pass.done || this.rank(pass, at.key) < pass.frontier;
	}

	/** Orders two matches down the timeline. */
	private compareInTimeline(step: -1 | 1, left: FindPosition, right: FindPosition): number {
		if (left.key !== right.key) return (left.key < right.key ? -1 : 1) * step;
		const order = (path: string) => this.live.get(path)?.order ?? this.results.note(path)?.order ?? 0;
		return order(left.path) - order(right.path) || left.index - right.index;
	}

	private navigate(direction: -1 | 1): void {
		if (!this.open || !this.pass || this.travelling) return;
		this.navigation = direction;
		this.resolveNavigation();
	}

	/**
	 * Moves to the next or previous match across the whole journal. When the
	 * walk has not yet counted the notes in between, it waits for them.
	 */
	private resolveNavigation(): void {
		const pass = this.pass;
		const direction = this.navigation;
		if (!pass || !direction || this.travelling) return;
		const selected = this.selected && this.results.indexOf(this.selected, pass.step) >= 0 ? this.selected : null;
		if (!selected) {
			// Nothing selected: Enter goes to the match nearest the reader.
			if (!pass.choosing) {
				// A finished walk can start over from anywhere; one under way
				// has its order fixed by where it started.
				if (!pass.done) return;
				pass.anchor = this.readerAnchor();
				pass.choosing = true;
			}
			this.navigation = 0;
			pass.reveal = true;
			this.lastInputAt = 0;
			this.choose(pass);
			return;
		}
		const next = direction > 0 ? this.results.after(selected, pass.step) : this.results.before(selected, pass.step);
		if (!next) return;
		if (!pass.done) {
			// Once the walk has counted both days, it has counted every day
			// between them. A step that wraps around the end of the timeline
			// waits for the whole journal.
			const onward = this.compareInTimeline(pass.step, next, selected) * direction > 0;
			if (!onward || !this.settled(pass, selected) || !this.settled(pass, next)) return;
		}
		this.navigation = 0;
		void this.goTo(next);
	}

	/** Selects `target` and brings it into view, first loading its day when it is not. */
	private async goTo(target: FindPosition): Promise<void> {
		const token = ++this.navigationToken;
		this.cancelJump();
		if (!this.live.has(target.path)) {
			this.select({ ...target, from: -1, to: -1 }, false);
			this.travelling = true;
			this.updateButtons();
			try {
				await this.host.loadFindDate(createMoment(target.key, DAY_KEY_FORMAT, true).startOf("day"));
			} catch (error) {
				console.error("Journal View: could not open a find result", error);
			} finally {
				if (token === this.navigationToken) {
					this.travelling = false;
					this.updateButtons();
				}
			}
			if (token !== this.navigationToken || !this.open || !this.pass || !this.host.isFindReady()) return;
			this.syncLive();
		}
		const note = this.live.get(target.path);
		if (note) this.select(this.selectionIn(note, target.index), true);
		if (this.navigation) this.resolveNavigation();
	}

	private selectionIn(note: LiveNote, index: number): FindSelection | null {
		const at = Math.min(index, note.ranges.length - 1);
		const range = note.ranges[at];
		return range ? { key: note.key, path: note.entry.path, index: at, from: range.from, to: range.to } : null;
	}

	private select(selection: FindSelection | null, reveal: boolean): void {
		const previous = this.selected ? this.live.get(this.selected.path) : undefined;
		this.selected = selection;
		const note = selection && selection.from >= 0 ? this.live.get(selection.path) : undefined;
		if (previous && previous !== note && previous.entry.el.isConnected) previous.entry.selectFindRange(null);
		if (selection && note) {
			const range = { from: selection.from, to: selection.to };
			note.entry.selectFindRange(range);
			if (reveal) {
				this.host.revealFindMatch(note.section, note.entry, range);
				window.requestAnimationFrame(() => this.focusInput());
			}
		}
		this.scheduleCount();
		this.updateButtons();
	}

	/** Travels to a chosen match on a day that is not loaded, once typing pauses. */
	private scheduleJump(): void {
		this.cancelJump();
		const delay = Math.max(0, this.lastInputAt + JUMP_DELAY - performance.now());
		this.jumpTimer = window.setTimeout(() => {
			this.jumpTimer = 0;
			const selected = this.selected;
			if (!this.open || !selected || this.live.has(selected.path)) return;
			void this.goTo(selected);
		}, delay);
	}

	private cancelJump(): void {
		window.clearTimeout(this.jumpTimer);
		this.jumpTimer = 0;
	}

	private toggleCase(): void {
		this.caseSensitive = !this.caseSensitive;
		this.caseButton.toggleClass("is-active", this.caseSensitive);
		this.caseButton.setAttribute("aria-pressed", String(this.caseSensitive));
		this.queryChanged();
		window.requestAnimationFrame(() => this.focusInput());
	}

	private onInputKeydown(event: KeyboardEvent): void {
		if (event.key !== "Enter") return;
		event.preventDefault();
		this.navigate(event.shiftKey ? -1 : 1);
	}

	/**
	 * The count is announced, so it is written at most once a frame, and only
	 * when it reads differently. The arrows go with it: an edit can bring the
	 * first match into a search that had none, or take the last one away.
	 */
	private scheduleCount(): void {
		if (this.countFrame) return;
		this.countFrame = window.requestAnimationFrame(() => {
			this.countFrame = 0;
			this.updateCount();
			this.updateButtons();
		});
	}

	private updateCount(): void {
		const pass = this.pass;
		let text = "";
		if (this.open && pass) {
			const total = this.results.total;
			const at = this.selected ? this.results.indexOf(this.selected, pass.step) : -1;
			if (!total) text = pass.done ? "No results" : "Searching…";
			else {
				text = at >= 0 ? `${at + 1} / ${total}` : `${total} ${total === 1 ? "result" : "results"}`;
				if (!pass.done) text += "…";
			}
		}
		if (this.countEl.textContent !== text) this.countEl.setText(text);
	}

	private updateButtons(): void {
		const pass = this.pass;
		const disabled = !pass || this.travelling || (pass.done && !this.results.total);
		this.previousButton.disabled = disabled;
		this.nextButton.disabled = disabled;
	}

	private clearSections(): void {
		for (const section of this.host.sections) {
			for (const entry of section.entries) entry.clearFindState();
		}
	}

	/** Stops every search and forgets its results. */
	private reset(): void {
		this.pass = null;
		this.navigationToken++;
		this.navigation = 0;
		this.travelling = false;
		this.cancelJump();
		window.cancelAnimationFrame(this.frame);
		window.cancelAnimationFrame(this.countFrame);
		this.frame = 0;
		this.countFrame = 0;
		this.pending = { search: false, live: false };
		this.changedPaths.clear();
		this.clearSections();
		this.results.clear();
		this.live.clear();
		this.liveKeys.clear();
		this.selected = null;
		this.cameFrom = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.releaseCorpus?.();
		this.releaseCorpus = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.open = false;
		this.reset();
		this.el.remove();
	}
}
