import { ItemView, Scope, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import type JournalViewPlugin from "./main";
import { AnchorHost, ScrollAnchor } from "./anchor";
import { DatePickerModal } from "./datePicker";
import { DayHost, DaySection } from "./day";
import { DayWalker, isOffsetReachable } from "./dayWalk";
import { EditorWindow, EditorWindowHost } from "./editorWindow";
import { distanceFromViewport, findAnchorIndex } from "./scroll";
import { JournalToolbar } from "./toolbar";
import { JournalFind, JournalFindHost } from "./find";
import type { FindRange } from "./findText";
import { createMoment } from "./moment";
import type { Moment } from "./moment";

export const VIEW_TYPE_JOURNAL = "journal-view";

/** Days built on either side of today when the view first opens. */
const INITIAL_RADIUS = 7;
/** How close to an end (px) the reader must get before more days are loaded. */
const LOAD_THRESHOLD = 1500;
/** Above this many live days, the end furthest from the reader is trimmed. */
const MAX_SECTIONS = 60;
/** How many days survive a trim. */
const TRIM_KEEP = 48;
/** Days closer than this (px) to the viewport are never trimmed. */
const TRIM_DISTANCE = LOAD_THRESHOLD * 2;
/** Per-frame scroll step (px) above which the reader is still travelling. */
const FLICK_STEP = 24;
/** How long after the last scroll step the view still counts as moving (ms). */
const FLICK_IDLE = 120;
/** Quiet time (ms) after which a scroll counts as finished. */
const SETTLE_DELAY = 180;

type TimelineEnd = "start" | "end";

/**
 * The journal is a window of consecutive days. Every day at or near the
 * viewport is a live editor: the reader can click straight into any text they
 * can see and the day does not change shape under the cursor. Days further out
 * are static markdown previews - fully laid out, at their true heights, with
 * nothing that re-measures itself while the reader scrolls, and far cheaper to
 * keep alive. Days cross between the two only while off screen (see
 * `EditorWindow`).
 *
 * The window grows before the reader reaches its edge. A day is prepared
 * asynchronously (file read + preview render, off-DOM), then committed
 * synchronously: insert, measure, and - when it landed above the reader -
 * move the scroll position down by exactly the height that appeared, all
 * inside one task. The browser never paints a frame where the content sits
 * in the wrong place. Whatever height still drifts in afterwards is cancelled
 * out by `ScrollAnchor`.
 */
export class JournalView extends ItemView implements DayHost, AnchorHost, EditorWindowHost, JournalFindHost {
	scrollEl!: HTMLElement;
	daysEl!: HTMLElement;
	sections: DaySection[] = [];

	private toolbar?: JournalToolbar;
	private find?: JournalFind;
	/** The open date picker, which has to go when the view does. */
	private picker: DatePickerModal | null = null;
	private readonly anchoring = new ScrollAnchor(this);
	private readonly editors = new EditorWindow(this);
	private walker!: DayWalker;

	private byPath = new Map<string, DaySection>();
	private today: Moment = createMoment().startOf("day");
	/**
	 * A day the reader went to by date. It stays in the journal even with empty
	 * days hidden - being asked for by name is reason enough to show a day.
	 */
	private visited: Moment | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private scrollFrame = 0;
	private animFrame = 0;
	/** Delayed editor focus used only by the initial open on today. */
	private initialFocusTimer = 0;
	/** Focus requested while the pane still had no measurable height. */
	private focusOnFirstResize = false;
	/** True while a pointer is held down in the scroller (scrollbar, selection). */
	private pointerHeld = false;
	/** Scroll position and pace, used to keep editor work out of a gesture. */
	private lastScrollTop = 0;
	private lastScrollAt = 0;
	private scrollStep = 0;
	private settleTimer = 0;
	private loading: Record<TimelineEnd, boolean> = { start: false, end: false };
	private exhausted: Record<TimelineEnd, boolean> = { start: false, end: false };
	/** Bumped on teardown so in-flight loads know to abandon their work. */
	private epoch = 0;
	/** False until the view has centred on today in a laid-out pane. */
	private centered = false;
	private ready = false;
	/** Offset of the day the current window was built around. */
	private origin = 0;
	/** A settings change that arrived while a build was in flight. */
	private settingsPending = false;
	private configSignature = "";
	private indexVersion = -1;
	private initialDate?: Moment;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: JournalViewPlugin,
	) {
		super(leaf);
		// Obsidian's workspace scope handles Escape before the find bar's DOM
		// listener can. Claim it only while focus is in journal-wide find, leaving
		// embedded-editor Escape handling (including Vim mode) untouched.
		this.scope = new Scope(this.app.scope);
		this.scope.register([], "Escape", (event) => {
			if (!this.find?.handleEscape(event)) return;
			return false;
		});
		// The active leaf keeps this scope even when focus is not inside a day.
		// A DOM listener alone misses Mod+F when the journal pane itself is
		// selected but no embedded editor owns the active element.
		this.scope.register(["Mod"], "f", () => {
			this.showFind();
			return false;
		});
		this.initialDate = plugin.consumeInitialDate(leaf);
		// Opening a note (from a day header, or a link inside a day) must not
		// replace the journal itself.
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_JOURNAL;
	}

	getDisplayText(): string {
		return "Journal";
	}

	getIcon(): string {
		return "notebook";
	}

	/* ----------------------------------------------------------- lifecycle */

	async onOpen(): Promise<void> {
		this.containerEl.addClass("journal-view");
		this.contentEl.empty();
		this.contentEl.addClass("journal-content");

		this.toolbar = new JournalToolbar(this, {
			onToggleFilter: () => void this.toggleHideEmptyDays(),
			onShowFind: () => this.showFind(),
			onGoToDate: () => this.openDatePicker(),
			onGoToToday: () => this.goToToday(true),
		});
		this.syncFilterButton();
		this.find = new JournalFind(this.contentEl, this);

		this.scrollEl = this.contentEl.createDiv({ cls: "journal-scroll" });

		this.registerDomEvent(this.scrollEl, "scroll", () => this.onScroll(), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointerdown", () => (this.pointerHeld = true), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointerup", () => (this.pointerHeld = false), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointercancel", () => (this.pointerHeld = false), { passive: true });
		// A drag that ends outside the pane never delivers its pointerup here.
		this.registerDomEvent(window, "pointerup", () => (this.pointerHeld = false), { passive: true });
		this.registerDomEvent(this.containerEl, "keydown", (event) => this.onKeydown(event), { capture: true });
		this.registerVaultEvents();

		const initialDate = this.initialDate;
		this.initialDate = undefined;
		if (initialDate) this.visited = initialDate.clone().startOf("day");
		await this.build(initialDate, !initialDate);
		if (initialDate) this.focusOriginWhenReady();
	}

	async onClose(): Promise<void> {
		// The picker holds this view in its callback, so a leaf that closes
		// while it is open would leave it able to navigate a dead journal.
		this.picker?.close();
		this.find?.destroy();
		this.find = undefined;
		this.toolbar?.destroy();
		this.toolbar = undefined;
		await this.flushAll();
		this.teardown();
	}

	private teardown(): void {
		this.epoch++;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.anchoring.clear();
		this.editors.destroy();
		if (this.scrollFrame) window.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = 0;
		if (this.animFrame) window.cancelAnimationFrame(this.animFrame);
		this.animFrame = 0;
		window.clearTimeout(this.initialFocusTimer);
		this.initialFocusTimer = 0;
		this.focusOnFirstResize = false;
		window.clearTimeout(this.settleTimer);
		this.settleTimer = 0;
		for (const section of this.sections) section.destroy();
		this.sections = [];
		this.byPath.clear();
		this.daysEl?.remove();
	}

	async flushAll(): Promise<void> {
		await Promise.all(this.sections.map((section) => section.flush()));
	}

	/* --------------------------------------------------------------- build */

	/**
	 * Builds a window of days centred on `around`, or on today when the caller
	 * has no day in mind. `focusToday` belongs to the initial open: any later
	 * rebuild happens under the reader, and taking their cursor would be theft.
	 */
	private async build(around?: Moment, focusToday = false): Promise<void> {
		this.ready = false;
		this.centered = false;
		this.today = createMoment().startOf("day");
		this.configSignature = JSON.stringify(this.plugin.daily.config());
		this.plugin.index.ensureCurrent();
		this.indexVersion = this.plugin.index.version;
		this.walker = new DayWalker(
			this.today,
			this.plugin.index,
			() => this.plugin.settings.hideEmptyDays,
			this.visited ?? undefined,
		);
		this.exhausted = { start: false, end: false };
		this.loading = { start: false, end: false };
		const epoch = ++this.epoch;

		this.daysEl = this.scrollEl.createDiv({ cls: "journal-days" });
		this.lastScrollTop = 0;
		this.lastScrollAt = 0;
		this.scrollStep = 0;
		this.anchoring.resetSpacer();
		if (this.scrollEl.clientHeight > 0) this.anchoring.setSpacer(this.anchoring.spacerBase());
		this.attachResizeObserver();

		// The chosen day, plus a few days either side.
		const origin = (this.origin = this.walker.origin(around));
		const step = this.sortStep();
		const before: number[] = [];
		let edge = origin;
		for (let i = 0; i < INITIAL_RADIUS; i++) {
			const next = this.walker.next(edge, (-step) as -1 | 1);
			if (next === null) {
				this.exhausted.start = true;
				break;
			}
			before.push(next);
			edge = next;
		}
		const after: number[] = [];
		edge = origin;
		for (let i = 0; i < INITIAL_RADIUS; i++) {
			const next = this.walker.next(edge, step);
			if (next === null) {
				this.exhausted.end = true;
				break;
			}
			after.push(next);
			edge = next;
		}
		const offsets = [...before.reverse(), origin, ...after];

		const sections = offsets.map((offset) => this.createSection(offset));
		await Promise.all(sections.map((section) => section.prepare()));
		if (epoch !== this.epoch) {
			for (const section of sections) section.destroy();
			return;
		}
		this.commit(sections, "end");

		this.ready = true;
		if (this.scrollEl.clientHeight > 0) {
			this.centerOn(this.sectionAt(origin), "instant");
			this.centered = true;
			// The days on screen become editors before the reader has looked at
			// them; that changes their heights, so aim at the origin again.
			this.editors.update({ includeVisible: true });
			this.centerOn(this.sectionAt(origin), "instant");
		} // else: the pane is hidden; the first real resize centres it.
		this.updateHeaderLabel();
		this.find?.sectionsChanged();

		if (
			focusToday &&
			this.plugin.settings.focusTodayOnOpen &&
			this.app.workspace.getActiveViewOfType(JournalView) === this
		) {
			this.initialFocusTimer = window.setTimeout(() => {
				this.initialFocusTimer = 0;
				this.sectionAt(0)?.focusEditor(true);
			}, 50);
		}
		// A short viewport may already sit near an end.
		this.onScroll();

		// A settings change that landed mid-build was read against the values
		// this window was built from; redo it now the view is whole again.
		if (this.settingsPending) {
			this.settingsPending = false;
			await this.rebuild(this.visibleDate(), focusToday);
		}
	}

	/** Rebuilds everything, e.g. after the daily-note format changed. */
	async rebuild(around?: Moment, focusToday = false): Promise<void> {
		// Closed for business from here on: flushing is asynchronous, and a
		// change arriving during it must queue rather than start a second
		// rebuild alongside this one.
		this.ready = false;
		await this.flushAll();
		this.teardown();
		await this.build(around, focusToday);
	}

	/** The day the reader is currently looking at, if the view has one. */
	private visibleDate(): Moment | undefined {
		if (!this.ready) return undefined;
		// A hidden pane measures as zero-height, so nothing can be located in
		// it; the anchor still names the day it was left on.
		const measurable = this.scrollEl && this.scrollEl.clientHeight > 0;
		const near = measurable ? this.anchoring.sectionNear(this.scrollEl.scrollTop) : null;
		return (near ?? this.anchoring.section)?.date;
	}

	private createSection(offset: number): DaySection {
		return new DaySection(this, this.walker.dateFor(offset), offset);
	}

	/** Date offset step made by moving down through the rendered timeline. */
	sortStep(): -1 | 1 {
		return this.plugin.settings.daySortDirection === "descending" ? -1 : 1;
	}

	/** DOM-order comparison for two date offsets. */
	private compareOffsets(left: number, right: number): number {
		return (left - right) * this.sortStep();
	}

	/**
	 * Carries date headings on the first rendered day in each group. Keeping the
	 * headings inside a day means loading, trimming and scroll anchoring still
	 * have one layout unit per date. Hidden empty days do not count as starts.
	 */
	private syncDateSeparators(): void {
		const showMonths = this.plugin.settings.showMonthSeparators;
		const showYears = this.plugin.settings.groupDaysByYear;
		let previousYear: string | null = null;
		let previousMonth: string | null = null;
		for (const section of this.sections) {
			if (section.isHidden) {
				section.setYearSeparator(false);
				section.setMonthSeparator(false);
				continue;
			}
			const year = section.date.format("YYYY");
			const month = section.date.format("YYYY-MM");
			// A year heading marks a boundary between rendered days; the sticky
			// toolbar supplies context for the first day in the current window.
			section.setYearSeparator(showYears && previousYear !== null && year !== previousYear);
			section.setMonthSeparator(showMonths && month !== previousMonth);
			previousYear = year;
			previousMonth = month;
		}
	}

	private sectionAt(offset: number): DaySection | undefined {
		return this.sections.find((section) => section.offset === offset);
	}

	private indexPaths(): void {
		this.byPath.clear();
		for (const section of this.sections) {
			this.byPath.set(section.path, section);
			if (section.file) this.byPath.set(section.file.path, section);
		}
	}

	/* ------------------------------------------------------------- loading */

	/**
	 * Inserts fully-prepared days into the DOM. Each day's preview was
	 * rendered before this is called, so insertion and layout happen within a
	 * single task at the days' true heights - the browser cannot paint a
	 * half-committed batch.
	 */
	private commit(sections: DaySection[], where: TimelineEnd): void {
		const fragment = createFragment();
		for (const section of sections) fragment.appendChild(section.el);
		if (where === "start") this.daysEl.insertBefore(fragment, this.daysEl.firstChild);
		else this.daysEl.appendChild(fragment);
		for (const section of sections) {
			this.byPath.set(section.path, section);
			if (section.file) this.byPath.set(section.file.path, section);
			this.resizeObserver?.observe(section.el);
		}
		if (where === "start") this.sections.unshift(...sections);
		else this.sections.push(...sections);
		this.syncDateSeparators();
		// A day can land inside the editor window on a tall pane.
		this.editors.schedule();
		if (this.ready) this.find?.sectionsChanged();
	}

	/** True while the viewport is within loading distance of a physical end. */
	private needsMore(end: TimelineEnd): boolean {
		const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
		if (end === "start") return scrollTop < LOAD_THRESHOLD;
		return scrollHeight - scrollTop - clientHeight < LOAD_THRESHOLD;
	}

	/**
	 * Extends the window one day at a time until the reader has LOAD_THRESHOLD
	 * of content between them and the end again. One day per frame keeps the
	 * cost of building an editor from ever stalling a scroll gesture, and
	 * inserting above the reader is offset by scrolling down the exact height
	 * that appeared - in the same task, so nothing on screen moves.
	 */
	private async extend(end: TimelineEnd): Promise<void> {
		if (!this.ready || this.loading[end] || this.exhausted[end]) return;
		if (!this.sections.length || this.scrollEl.clientHeight === 0) return;
		this.loading[end] = true;
		try {
			const sortStep = this.sortStep();
			const step = (end === "start" ? -sortStep : sortStep) as -1 | 1;
			// A generous cap in case something keeps the loop from converging.
			for (let i = 0; i < 50 && this.needsMore(end); i++) {
				const edge =
					end === "start" ? this.sections[0].offset : this.sections[this.sections.length - 1].offset;
				const next = this.walker.next(edge, step);
				if (next === null) {
					this.exhausted[end] = true;
					return;
				}

				const epoch = this.epoch;
				const section = this.createSection(next);
				await section.prepare();
				if (epoch !== this.epoch) {
					section.destroy();
					return;
				}

				if (end === "start") {
					const referenceDay = this.sections[0];
					const before = referenceDay.contentTop;
					// The compensating write below happens anyway, so the
					// spacer is topped back up in the same breath - it is what
					// absorbs late height changes (images loading, the day
					// being edited growing) without touching the scroll
					// position.
					const base = this.anchoring.spacerBase();
					if (this.anchoring.spacerHeight() < base) this.anchoring.setSpacer(base);
					this.commit([section], "start");
					const delta = referenceDay.contentTop - before;
					if (delta !== 0) this.scrollEl.scrollTop += delta;
					this.editors.declareScroll();
					this.anchoring.pin();
				} else {
					this.commit([section], "end");
				}
				this.trim(end === "start" ? "end" : "start");

				await this.nextFrame();
				if (epoch !== this.epoch) return;
			}
		} finally {
			this.loading[end] = false;
		}
	}

	private nextFrame(): Promise<void> {
		return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
	}

	/**
	 * Caps how many days are alive at once by dropping them from the end the
	 * reader is moving away from. Removing below the viewport is free;
	 * removing above it pulls the scroll position up by the removed height in
	 * the same task, so nothing on screen moves. Unsaved edits are handed to
	 * the save queue by `destroy`, and a trimmed end is no longer exhausted -
	 * scrolling back simply reloads it.
	 */
	private trim(end: TimelineEnd): void {
		if (this.sections.length <= MAX_SECTIONS) return;
		let budget = this.sections.length - TRIM_KEEP;
		const victims: DaySection[] = [];

		if (end === "end") {
			for (let i = this.sections.length - 1; i >= 0 && budget > 0; i--, budget--) {
				const section = this.sections[i];
				if (section.hasFocus || this.distanceFrom(section) < TRIM_DISTANCE) break;
				victims.push(section);
			}
			if (!victims.length) return;
			this.sections.length -= victims.length;
			for (const section of victims) this.forget(section);
			this.syncDateSeparators();
		} else {
			for (let i = 0; i < this.sections.length && budget > 0; i++, budget--) {
				const section = this.sections[i];
				if (section.hasFocus || this.distanceFrom(section) < TRIM_DISTANCE) break;
				victims.push(section);
			}
			const referenceDay = this.sections[victims.length];
			if (!victims.length || !referenceDay) return;
			const before = referenceDay.contentTop;
			this.sections.splice(0, victims.length);
			for (const section of victims) this.forget(section);
			this.syncDateSeparators();
			const delta = referenceDay.contentTop - before;
			if (delta !== 0) this.scrollEl.scrollTop += delta;
			this.editors.declareScroll();
			this.anchoring.pin();
		}
		this.exhausted[end] = false;
		this.find?.sectionsChanged();
	}

	private forget(section: DaySection): void {
		this.resizeObserver?.unobserve(section.el);
		this.byPath.delete(section.path);
		if (section.file) this.byPath.delete(section.file.path);
		this.anchoring.forget(section);
		section.destroy();
	}

	/**
	 * True while a day is out of sight. Swapping a day's body is only ever
	 * allowed here, and the answer has to be asked for again after any await -
	 * rendering a preview takes long enough for a scroll to bring the day back.
	 */
	isOffScreen(day: DaySection): boolean {
		if (!this.scrollEl || this.scrollEl.clientHeight === 0) return true;
		return this.distanceFrom(day) > 0;
	}

	private distanceFrom(section: DaySection): number {
		return distanceFromViewport(this.scrollEl, section.el);
	}

	/* --------------------------------------------------- collaborator hooks */

	isReady(): boolean {
		return this.ready;
	}

	/** True while the view is moving fast enough that the reader is still travelling. */
	isFlicking(): boolean {
		return this.scrollStep > FLICK_STEP && performance.now() - this.lastScrollAt < FLICK_IDLE;
	}

	isPointerHeld(): boolean {
		return this.pointerHeld;
	}

	settleAnchor(): void {
		this.anchoring.settle();
	}

	onAnchorScroll(): void {
		this.editors.declareScroll();
	}

	onGuardScroll(top: number): void {
		this.lastScrollTop = top;
		this.anchoring.pin();
	}

	/**
	 * Called once the scroll has been quiet for a moment. This is when work
	 * that has to write the scroll position is safe: nothing is in flight for
	 * it to cut short.
	 */
	private onSettle(): void {
		this.settleTimer = 0;
		if (!this.ready || !this.scrollEl || this.scrollEl.clientHeight === 0) return;
		// Whatever the spacer had to spend on corrections is put back here, and
		// the position that leaves is the one the reader is now at.
		if (this.anchoring.replenishSpacer()) this.lastScrollTop = this.scrollEl.scrollTop;
		this.editors.update();
	}

	/* ---------------------------------------------------------- pane layout */

	private attachResizeObserver(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.scrollEl);
	}

	private handleResize(): void {
		if (!this.ready) return;
		if (!this.centered) {
			// The view was built while its pane was hidden; centre it on the
			// first frame it actually has a size.
			if (this.scrollEl.clientHeight === 0) return;
			this.anchoring.resetSpacer();
			this.anchoring.setSpacer(this.anchoring.spacerBase());
			const section = this.sectionAt(this.origin) ?? this.sections[0];
			this.centerOn(section, "instant");
			this.centered = true;
			this.editors.update({ includeVisible: true });
			this.centerOn(section, "instant");
			if (this.focusOnFirstResize) {
				this.focusOnFirstResize = false;
				section.focusEditor();
			}
			this.onScroll();
			return;
		}
		this.anchoring.settle();
		// A pane that changed size has a different set of days near enough to
		// the viewport to be worth an editor.
		this.editors.schedule();
	}

	/* ------------------------------------------------------------ scrolling */

	private onScroll(): void {
		// Taken before anything below moves the position: this is the reader's
		// own step, and it is roughly per frame - the browser fires at most one
		// scroll event per frame.
		const top = this.scrollEl.scrollTop;
		this.scrollStep = Math.abs(top - this.lastScrollTop);
		this.lastScrollTop = top;
		this.lastScrollAt = performance.now();
		window.clearTimeout(this.settleTimer);
		this.settleTimer = window.setTimeout(() => this.onSettle(), SETTLE_DELAY);

		// Two steps, in this order. Within a frame, scroll events run before
		// ResizeObserver callbacks - so when a day changed height in a
		// background task (an editor expanding as it is revealed), this scroll
		// event sees the shifted layout before the observer has re-pinned it.
		// Settling the drift against the previous anchor first keeps that
		// shift out of the reader's view; re-anchoring straight away would
		// accept the shifted layout as truth, which reads as the view jumping
		// by exactly the amount the day grew.
		this.anchoring.settle();
		this.anchoring.pin();

		if (this.scrollFrame) return;
		this.scrollFrame = window.requestAnimationFrame(() => {
			this.scrollFrame = 0;
			if (!this.scrollEl || !this.ready) return;
			this.updateHeaderLabel();
			this.editors.update();
			if (this.needsMore("start")) void this.extend("start");
			if (this.needsMore("end")) void this.extend("end");
		});
	}

	private onKeydown(event: KeyboardEvent): void {
		if (
			event.key.toLowerCase() !== "f" ||
			(!event.metaKey && !event.ctrlKey) ||
			event.altKey ||
			event.shiftKey
		) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.showFind();
	}

	showFind(): void {
		this.find?.show();
	}

	setFindMode(open: boolean): void {
		this.toolbar?.setVisible(!open);
	}

	isFindReady(): boolean {
		return this.ready;
	}

	findAnchorSection(): DaySection | null {
		const focused = this.sections.find((section) => section.hasFocus);
		if (focused) return focused;
		if (!this.ready || !this.scrollEl || this.scrollEl.clientHeight === 0) return this.anchoring.section;
		return this.anchoring.sectionNear(this.scrollEl.scrollTop) ?? this.anchoring.section;
	}

	revealFindMatch(section: DaySection, range: FindRange): void {
		if (!section.el.isConnected) return;
		this.centerOn(section, "instant");
		const mounted = this.editors.mountForFind(section);
		const reveal = () => {
			if (!section.el.isConnected) return;
			section.revealFindRange(range);
			this.editors.declareScroll();
			this.anchoring.pin();
		};
		if (!mounted) {
			reveal();
			window.requestAnimationFrame(reveal);
			return;
		}
		// Let the editor mount guard finish before the intentional match reveal;
		// otherwise a deep result in a long preview resembles the mount jump that
		// the guard is designed to undo.
		window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
	}

	async loadFindDate(date: Moment): Promise<void> {
		await this.rebuild(date, false);
	}

	private centerTarget(section: DaySection): number {
		return Math.max(
			0,
			section.cardTop - Math.max(0, (this.scrollEl.clientHeight - section.cardHeight) / 2),
		);
	}

	private centerOn(section: DaySection | undefined, behavior: "instant" | "smooth", onArrive?: () => void): void {
		if (!section) return;
		if (this.animFrame) {
			window.cancelAnimationFrame(this.animFrame);
			this.animFrame = 0;
		}
		if (behavior === "instant") {
			this.scrollEl.scrollTop = this.centerTarget(section);
			this.editors.declareScroll();
			this.anchoring.pin();
			onArrive?.();
			return;
		}

		// The scroll animation is driven by hand, recomputing the destination
		// every frame. The browser's own smooth scrolling aims at a fixed
		// pixel offset and abandons the animation the moment anything else
		// touches scrollTop - a batch loading mid-flight would leave it
		// stranded somewhere random.
		const started = performance.now();
		const step = () => {
			this.animFrame = 0;
			if (!this.scrollEl || !section.el.isConnected) return;
			const target = this.centerTarget(section);
			const remaining = target - this.scrollEl.scrollTop;
			if (Math.abs(remaining) < 4 || performance.now() - started > 1500) {
				this.scrollEl.scrollTop = target;
				this.editors.declareScroll();
				this.anchoring.pin();
				onArrive?.();
				return;
			}
			this.scrollEl.scrollTop += remaining * 0.22;
			this.editors.declareScroll();
			this.anchoring.pin();
			this.animFrame = window.requestAnimationFrame(step);
		};
		this.animFrame = window.requestAnimationFrame(step);
	}

	goToToday(focus = false): void {
		const now = createMoment().startOf("day");
		// Coming home also gives up the day the reader went to by date; today
		// is pinned in its own right.
		const droppedVisited = this.visited !== null && !this.visited.isSame(now, "day");
		this.visited = null;
		if (droppedVisited && this.plugin.settings.hideEmptyDays) {
			void this.rebuild().then(() => {
				if (focus) this.sectionAt(0)?.focusEditor(true);
			});
			return;
		}
		const section = this.sectionAt(0);
		if (!now.isSame(this.today, "day") || !section) {
			// Midnight has passed, or today was trimmed away after a long
			// scroll - rebuilding recentres on today directly.
			void this.rebuild().then(() => {
				if (focus) this.sectionAt(0)?.focusEditor(true);
			});
			return;
		}
		// Focus only once the animation has arrived: focusing an editor makes
		// the browser scroll it into view, which would fight the animation.
		this.centerOn(section, "smooth", focus ? () => section.focusEditor(true) : undefined);
	}

	/** Opens the calendar, on the day the reader is currently looking at. */
	private openDatePicker(): void {
		// The dots come straight from the index, so it has to agree with the
		// vault's current daily-note configuration before any of them are drawn.
		this.plugin.index.ensureCurrent();
		this.picker?.close();
		const picker = new DatePickerModal(this.app, {
			index: this.plugin.index,
			today: createMoment().startOf("day"),
			current: this.visibleDate(),
			allowDistantNotes: this.plugin.settings.hideEmptyDays,
			onPick: (date) => this.goToDate(date),
			onDismiss: () => {
				if (this.picker === picker) this.picker = null;
			},
		});
		this.picker = picker;
		picker.open();
	}

	/**
	 * Moves the journal to `date`. A day already in the window is scrolled to;
	 * anything further away is a rebuild around that day. A day with no note is
	 * shown either way, empty days hidden or not - it is where the reader asked
	 * to be, and it is where they would start writing.
	 */
	goToDate(date: Moment, focus = true): void {
		// A date can arrive from a picker that outlived the view it was opened
		// from - the plugin reloading under it, say.
		if (!this.scrollEl?.isConnected) return;
		// A freshly created view may still be waiting to focus today. A direct
		// navigation owns focus now, so do not let that delayed callback steal it.
		window.clearTimeout(this.initialFocusTimer);
		this.initialFocusTimer = 0;
		const day = date.clone().startOf("day");
		const offset = day.diff(this.today, "days");
		const indexed = this.plugin.index.has(this.walker.keyFor(offset));
		if (!isOffsetReachable(offset, this.plugin.settings.hideEmptyDays, indexed)) return;
		const changedVisited = !this.visited?.isSame(day, "day");
		this.visited = day;
		// A view built while hidden has not committed to a scroll position yet.
		// Rebuild around the requested day so its first measurable resize cannot
		// centre the old origin over this navigation.
		if (!this.centered) {
			void this.rebuild(day).then(() => {
				if (focus) this.focusOriginWhenReady();
			});
			return;
		}
		if (changedVisited && this.plugin.settings.hideEmptyDays) {
			void this.rebuild(day).then(() => {
				if (focus) this.sectionAt(this.origin)?.focusEditor();
			});
			return;
		}

		const section = createMoment().startOf("day").isSame(this.today, "day") ? this.sectionAt(offset) : undefined;
		if (section) {
			// Focusing only once the animation has arrived: focus scrolls the
			// editor into view, which would fight it. Same as `goToToday`.
			this.centerOn(section, "smooth", focus ? () => section.focusEditor() : undefined);
			return;
		}
		void this.rebuild(day).then(() => {
			if (focus) this.sectionAt(this.origin)?.focusEditor();
		});
	}

	private focusOriginWhenReady(): void {
		const section = this.sectionAt(this.origin);
		if (this.centered && section) section.focusEditor();
		else this.focusOnFirstResize = true;
	}

	private updateHeaderLabel(): void {
		if (!this.ready || !this.toolbar) return;
		// The first day at the viewport top determines the sticky group label. The
		// indexed lookup skips filtered days, falls back to the first day in top
		// padding, and retains the last day in bottom padding.
		const at = findAnchorIndex(
			this.sections.length,
			(index) => {
				const el = this.sections[index].el;
				return el.offsetParent === null ? null : el.offsetTop;
			},
			this.scrollEl.scrollTop,
		);
		const section = at >= 0 ? this.sections[at] : this.anchoring.section;
		let label = "Journal";
		if (section && this.plugin.settings.showMonthSeparators) label = section.date.format("MMMM YYYY");
		else if (section && this.plugin.settings.groupDaysByYear) label = section.date.format("YYYY");
		this.toolbar.setLabel(label);
	}

	/* -------------------------------------------------------- vault events */

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) this.attachFile(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.syncWithIndex();
				const section = this.byPath.get(file.path);
				if (!section || section.file?.path !== file.path) return;
				this.byPath.delete(file.path);
				section.setFile(null);
				void section.reload();
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				const previous = this.byPath.get(oldPath);
				if (previous && previous.file?.path === oldPath) {
					this.byPath.delete(oldPath);
					previous.setFile(null);
				}
				if (file instanceof TFile) this.attachFile(file);
				else this.syncWithIndex();
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				const section = this.byPath.get(file.path);
				if (section?.file?.path === file.path) void section.reload();
			}),
		);

		// The daily-note configuration can change under us (core settings,
		// Periodic Notes); re-resolve paths when it does, and roll over at
		// midnight if the view has been left open.
		this.registerInterval(
			window.setInterval(() => {
				this.revalidatePaths();
				this.checkDayRollover();
			}, 30_000),
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.revalidatePaths()));
	}

	private checkDayRollover(): void {
		if (!this.ready) return;
		if (createMoment().startOf("day").isSame(this.today, "day")) return;
		if (this.sections.some((section) => section.hasFocus)) return;
		void this.rebuild();
	}

	private attachFile(file: TFile): void {
		this.syncWithIndex();
		let section = this.byPath.get(file.path);
		if (!section) {
			// A note can appear for a day the view skipped over (sync, another
			// window, "hide empty days" turned on). Slot it into place.
			const key = this.plugin.index.keyForPath(file.path);
			section = key ? this.ensureSectionFor(this.walker.offsetFor(key)) : undefined;
		}
		if (!section || section.file?.path === file.path) return;
		if (section.path !== file.path) return;
		section.setFile(file);
		void section.reload();
	}

	/**
	 * A day appearing or disappearing can un-exhaust an end of the journal, so
	 * loading is allowed to try again.
	 */
	private syncWithIndex(): void {
		if (this.plugin.index.version === this.indexVersion) return;
		this.indexVersion = this.plugin.index.version;
		this.exhausted = { start: false, end: false };
	}

	/** Materialises a day that falls inside the range already rendered. */
	private ensureSectionFor(offset: number): DaySection | undefined {
		if (!this.ready || !this.sections.length) return undefined;
		if (
			this.compareOffsets(offset, this.sections[0].offset) < 0 ||
			this.compareOffsets(offset, this.sections[this.sections.length - 1].offset) > 0
		) {
			return undefined; // outside the window - the scroll loader will reach it
		}

		let at = this.sections.findIndex((section) => this.compareOffsets(section.offset, offset) >= 0);
		if (at < 0) at = this.sections.length;
		if (this.sections[at]?.offset === offset) return this.sections[at];

		const section = this.createSection(offset);
		this.daysEl.insertBefore(section.el, this.sections[at]?.el ?? null);
		// The caller reloads the real content right after; the day starts
		// empty and any growth is re-pinned by the resize observer.
		this.sections.splice(at, 0, section);
		this.syncDateSeparators();
		this.byPath.set(section.path, section);
		if (section.file) this.byPath.set(section.file.path, section);
		this.resizeObserver?.observe(section.el);
		this.anchoring.settle();
		this.editors.schedule();
		return section;
	}

	/**
	 * Today, and a day the reader went to by date, are the journal's own days
	 * rather than the index's - the walker decides which, so a day it built
	 * against the filter is not then hidden by the day itself.
	 */
	isPinnedDay(day: DaySection): boolean {
		return this.walker ? this.walker.isPinned(day.offset) : day.offset === 0;
	}

	onDayFileChanged(day: DaySection, previousPath: string | null): void {
		if (previousPath) this.byPath.delete(previousPath);
		this.byPath.set(day.path, day);
		if (day.file) this.byPath.set(day.file.path, day);
		this.syncDateSeparators();
	}

	onDayContentChanged(_day: DaySection): void {
		this.find?.sectionsChanged();
	}

	private revalidatePaths(): void {
		if (!this.ready) return;
		// Resolving every day's path is not free, so only do it when the vault's
		// daily-note configuration actually moved.
		const signature = JSON.stringify(this.plugin.daily.config());
		if (signature === this.configSignature) return;
		this.configSignature = signature;
		this.plugin.index.ensureCurrent();
		this.syncWithIndex();

		let changed = false;
		for (const section of this.sections) {
			const before = section.path;
			section.revalidate();
			if (section.path !== before) changed = true;
		}
		this.syncDateSeparators();
		if (changed) this.indexPaths();
	}

	/* ------------------------------------------------------------ settings */

	/**
	 * Flips the same setting the settings tab owns, so every open journal - and
	 * the tab itself, next time it is drawn - follows along.
	 */
	private async toggleHideEmptyDays(): Promise<void> {
		this.plugin.settings.hideEmptyDays = !this.plugin.settings.hideEmptyDays;
		this.syncFilterButton();
		await this.plugin.saveSettings();
	}

	private syncFilterButton(): void {
		// Settings can be saved from elsewhere before this view has a toolbar.
		this.toolbar?.setFilter(this.plugin.settings.hideEmptyDays);
	}

	async onSettingsChanged(): Promise<void> {
		this.syncFilterButton();
		if (!this.ready) {
			// A build is in flight against the old values - dropping the change
			// here would leave the toolbar and the days disagreeing.
			this.settingsPending = true;
			return;
		}
		// The editor kind, date format and hidden-day handling all affect every
		// day, so the honest answer is a rebuild - but around the day the
		// reader was on, not today, so their place in the journal survives.
		await this.rebuild(this.visibleDate());
	}
}
