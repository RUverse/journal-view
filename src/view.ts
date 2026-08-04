import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, moment, setIcon, setTooltip } from "obsidian";
import type { Moment } from "moment";
import type JournalViewPlugin from "./main";
import { DayHost, DaySection } from "./day";
import { DAY_KEY_FORMAT } from "./noteIndex";
import { findAnchorIndex } from "./scroll";

export const VIEW_TYPE_JOURNAL = "journal-view";

/** Days built on either side of today when the view first opens. */
const INITIAL_RADIUS = 7;
/** How close to an end (px) the reader must get before more days are loaded. */
const LOAD_THRESHOLD = 1500;
/** Hard stop so a runaway scroll cannot allocate forever (~13 years). */
const MAX_OFFSET = 5000;
/** Above this many live days, the end furthest from the reader is trimmed. */
const MAX_SECTIONS = 60;
/** How many days survive a trim. */
const TRIM_KEEP = 48;
/** Days closer than this (px) to the viewport are never trimmed. */
const TRIM_DISTANCE = LOAD_THRESHOLD * 2;
/**
 * How far beyond the viewport (px) days are kept as live editors. At least a
 * screenful, so a day is an editor well before the reader can scroll to it and
 * click. Days beyond twice this go back to a preview; the gap between the two
 * keeps a day sitting on the boundary from flipping back and forth.
 */
const EDITOR_MARGIN = 800;
/** Editors mounted per frame, so a burst of them cannot stall a scroll. */
const MOUNTS_PER_FRAME = 2;
/** Per-frame scroll step (px) above which the reader is still travelling. */
const FLICK_STEP = 24;
/** How long after the last scroll step the view still counts as moving (ms). */
const FLICK_IDLE = 120;
/** Quiet time (ms) after which a scroll counts as finished. */
const SETTLE_DELAY = 180;

/**
 * The journal is a window of consecutive days. Every day at or near the
 * viewport is a live editor: the reader can click straight into any text they
 * can see and the day does not change shape under the cursor. Days further out
 * are static markdown previews - fully laid out, at their true heights, with
 * nothing that re-measures itself while the reader scrolls, and far cheaper to
 * keep alive. Days cross between the two only while off screen.
 *
 * The window grows before the reader reaches its edge. A day is prepared
 * asynchronously (file read + preview render, off-DOM), then committed
 * synchronously: insert, measure, and - when it landed above the reader -
 * move the scroll position down by exactly the height that appeared, all
 * inside one task. The browser never paints a frame where the content sits
 * in the wrong place.
 */
export class JournalView extends ItemView implements DayHost {
	private scrollEl!: HTMLElement;
	private daysEl!: HTMLElement;
	private headerLabelEl!: HTMLElement;

	private sections: DaySection[] = [];
	private byPath = new Map<string, DaySection>();
	private today: Moment = moment().startOf("day");

	private resizeObserver: ResizeObserver | null = null;
	private anchor: { el: HTMLElement; section: DaySection; top: number } | null = null;
	private scrollFrame = 0;
	private animFrame = 0;
	private editorFrame = 0;
	private guardFrame = 0;
	/** Scroll position a freshly mounted editor must not move the view away from. */
	private guardExpected: number | null = null;
	private guardFrames = 0;
	/** True while a pointer is held down in the scroller (scrollbar, selection). */
	private pointerHeld = false;
	/** Scroll position and pace, used to keep editor work out of a gesture. */
	private lastScrollTop = 0;
	private lastScrollAt = 0;
	private scrollStep = 0;
	private settleTimer = 0;
	private loading = { past: false, future: false };
	private exhausted = { past: false, future: false };
	/** Current height (px) of the padding above the first day; null = untouched CSS. */
	private spacerPx: number | null = null;
	/** Bumped on teardown so in-flight loads know to abandon their work. */
	private epoch = 0;
	/** False until the view has centred on today in a laid-out pane. */
	private centered = false;
	private ready = false;
	private configSignature = "";
	private indexVersion = -1;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: JournalViewPlugin,
	) {
		super(leaf);
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
		return "calendar-days";
	}

	/* ----------------------------------------------------------- lifecycle */

	async onOpen(): Promise<void> {
		this.containerEl.addClass("journal-view");
		this.contentEl.empty();
		this.contentEl.addClass("journal-content");

		const toolbar = this.contentEl.createDiv({ cls: "journal-toolbar" });
		this.headerLabelEl = toolbar.createDiv({ cls: "journal-toolbar-label", text: "Journal" });
		const actions = toolbar.createDiv({ cls: "journal-toolbar-actions" });

		const todayButton = actions.createEl("button", { cls: "clickable-icon journal-toolbar-button" });
		setIcon(todayButton, "calendar-check");
		setTooltip(todayButton, "Go to today");
		todayButton.addEventListener("click", () => this.goToToday(true));

		this.scrollEl = this.contentEl.createDiv({ cls: "journal-scroll" });

		this.registerDomEvent(this.scrollEl, "scroll", () => this.onScroll(), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointerdown", () => (this.pointerHeld = true), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointerup", () => (this.pointerHeld = false), { passive: true });
		this.registerDomEvent(this.scrollEl, "pointercancel", () => (this.pointerHeld = false), { passive: true });
		// A drag that ends outside the pane never delivers its pointerup here.
		this.registerDomEvent(window, "pointerup", () => (this.pointerHeld = false), { passive: true });
		this.registerVaultEvents();

		await this.build();
	}

	async onClose(): Promise<void> {
		await this.flushAll();
		this.teardown();
	}

	private teardown(): void {
		this.epoch++;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.anchor = null;
		if (this.scrollFrame) window.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = 0;
		if (this.animFrame) window.cancelAnimationFrame(this.animFrame);
		this.animFrame = 0;
		if (this.editorFrame) window.cancelAnimationFrame(this.editorFrame);
		this.editorFrame = 0;
		if (this.guardFrame) window.cancelAnimationFrame(this.guardFrame);
		this.guardFrame = 0;
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

	private async build(): Promise<void> {
		this.ready = false;
		this.centered = false;
		this.today = moment().startOf("day");
		this.configSignature = JSON.stringify(this.plugin.daily.config());
		this.plugin.index.ensureCurrent();
		this.indexVersion = this.plugin.index.version;
		this.exhausted = { past: false, future: false };
		this.loading = { past: false, future: false };
		const epoch = ++this.epoch;

		this.daysEl = this.scrollEl.createDiv({ cls: "journal-days" });
		this.lastScrollTop = 0;
		this.lastScrollAt = 0;
		this.scrollStep = 0;
		this.spacerPx = null;
		if (this.scrollEl.clientHeight > 0) this.setSpacer(this.spacerBase());
		this.attachResizeObserver();

		// Today, plus a few days either side.
		const past: number[] = [];
		let edge = 0;
		for (let i = 0; i < INITIAL_RADIUS; i++) {
			const next = this.nextOffset(edge, -1);
			if (next === null) {
				this.exhausted.past = true;
				break;
			}
			past.push(next);
			edge = next;
		}
		const future: number[] = [];
		edge = 0;
		for (let i = 0; i < INITIAL_RADIUS; i++) {
			const next = this.nextOffset(edge, 1);
			if (next === null) {
				this.exhausted.future = true;
				break;
			}
			future.push(next);
			edge = next;
		}
		const offsets = [...past.reverse(), 0, ...future];

		const sections = offsets.map((offset) => this.createSection(offset));
		await Promise.all(sections.map((section) => section.prepare()));
		if (epoch !== this.epoch) {
			for (const section of sections) section.destroy();
			return;
		}
		this.commit(sections, "end");

		this.ready = true;
		if (this.scrollEl.clientHeight > 0) {
			this.centerOn(this.sectionAt(0), "instant");
			this.centered = true;
			// The days on screen become editors before the reader has looked at
			// them; that changes their heights, so aim at today again.
			this.updateEditors({ includeVisible: true });
			this.centerOn(this.sectionAt(0), "instant");
		} // else: the pane is hidden; the first real resize centres it.
		this.updateHeaderLabel();

		if (this.plugin.settings.focusTodayOnOpen && this.app.workspace.getActiveViewOfType(JournalView) === this) {
			window.setTimeout(() => this.sectionAt(0)?.focusEditor(), 50);
		}
		// A short viewport may already sit near an end.
		this.onScroll();
	}

	/** Rebuilds everything, e.g. after the daily-note format changed. */
	async rebuild(): Promise<void> {
		await this.flushAll();
		this.teardown();
		await this.build();
	}

	private createSection(offset: number): DaySection {
		return new DaySection(this, this.today.clone().add(offset, "days"), offset);
	}

	private sectionAt(offset: number): DaySection | undefined {
		return this.sections.find((section) => section.offset === offset);
	}

	private keyForOffset(offset: number): string {
		return this.today.clone().add(offset, "days").format(DAY_KEY_FORMAT);
	}

	private offsetForKey(key: string): number {
		return moment(key, DAY_KEY_FORMAT).startOf("day").diff(this.today, "days");
	}

	/**
	 * The next day the view should render in `direction`. With empty days
	 * hidden this skips straight to the next day that actually has a note, so
	 * the view never has to materialise a run of blank days to cross a gap.
	 */
	private nextOffset(from: number, direction: -1 | 1): number | null {
		let offset: number;
		if (this.plugin.settings.hideEmptyDays) {
			const key = this.keyForOffset(from);
			const found = direction < 0 ? this.plugin.index.prev(key) : this.plugin.index.next(key);
			if (!found) return null;
			offset = this.offsetForKey(found);
		} else {
			offset = from + direction;
		}
		return Math.abs(offset) > MAX_OFFSET ? null : offset;
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
	private commit(sections: DaySection[], where: "start" | "end"): void {
		const fragment = document.createDocumentFragment();
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
		// A day can land inside the editor window on a tall pane.
		this.scheduleEditors();
	}

	/** True while the viewport is within loading distance of `direction`'s end. */
	private needsMore(direction: "past" | "future"): boolean {
		const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
		if (direction === "past") return scrollTop < LOAD_THRESHOLD;
		return scrollHeight - scrollTop - clientHeight < LOAD_THRESHOLD;
	}

	/**
	 * Extends the window one day at a time until the reader has LOAD_THRESHOLD
	 * of content between them and the end again. One day per frame keeps the
	 * cost of building an editor from ever stalling a scroll gesture, and
	 * inserting above the reader is offset by scrolling down the exact height
	 * that appeared - in the same task, so nothing on screen moves.
	 */
	private async extend(direction: "past" | "future"): Promise<void> {
		if (!this.ready || this.loading[direction] || this.exhausted[direction]) return;
		if (!this.sections.length || this.scrollEl.clientHeight === 0) return;
		this.loading[direction] = true;
		try {
			const step = direction === "past" ? -1 : 1;
			// A generous cap in case something keeps the loop from converging.
			for (let i = 0; i < 50 && this.needsMore(direction); i++) {
				const edge =
					direction === "past" ? this.sections[0].offset : this.sections[this.sections.length - 1].offset;
				const next = this.nextOffset(edge, step);
				if (next === null) {
					this.exhausted[direction] = true;
					return;
				}

				const epoch = this.epoch;
				const section = this.createSection(next);
				await section.prepare();
				if (epoch !== this.epoch) {
					section.destroy();
					return;
				}

				if (direction === "past") {
					const ref = this.sections[0].el;
					const before = ref.offsetTop;
					// The compensating write below happens anyway, so the
					// spacer is topped back up in the same breath - it is what
					// absorbs late height changes (images loading, the day
					// being edited growing) without touching the scroll
					// position.
					const base = this.spacerBase();
					if (this.spacerHeight() < base) this.setSpacer(base);
					this.commit([section], "start");
					const delta = ref.offsetTop - before;
					if (delta !== 0) this.scrollEl.scrollTop += delta;
					this.scrollMoved();
					this.updateAnchor();
				} else {
					this.commit([section], "end");
				}
				this.trim(direction === "past" ? "future" : "past");

				await this.nextFrame();
				if (epoch !== this.epoch) return;
			}
		} finally {
			this.loading[direction] = false;
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
	private trim(end: "past" | "future"): void {
		if (this.sections.length <= MAX_SECTIONS) return;
		let budget = this.sections.length - TRIM_KEEP;
		const victims: DaySection[] = [];

		if (end === "future") {
			for (let i = this.sections.length - 1; i >= 0 && budget > 0; i--, budget--) {
				const section = this.sections[i];
				if (section.hasFocus || this.distanceFromViewport(section) < TRIM_DISTANCE) break;
				victims.push(section);
			}
			if (!victims.length) return;
			this.sections.length -= victims.length;
			for (const section of victims) this.forget(section);
		} else {
			for (let i = 0; i < this.sections.length && budget > 0; i++, budget--) {
				const section = this.sections[i];
				if (section.hasFocus || this.distanceFromViewport(section) < TRIM_DISTANCE) break;
				victims.push(section);
			}
			const ref = this.sections[victims.length]?.el;
			if (!victims.length || !ref) return;
			const before = ref.offsetTop;
			this.sections.splice(0, victims.length);
			for (const section of victims) this.forget(section);
			const delta = ref.offsetTop - before;
			if (delta !== 0) this.scrollEl.scrollTop += delta;
			this.scrollMoved();
			this.updateAnchor();
		}
		this.exhausted[end] = false;
	}

	private forget(section: DaySection): void {
		this.resizeObserver?.unobserve(section.el);
		this.byPath.delete(section.path);
		if (section.file) this.byPath.delete(section.file.path);
		if (this.anchor?.section === section) this.anchor = null;
		section.destroy();
	}

	/**
	 * True while a day is out of sight. Swapping a day's body is only ever
	 * allowed here, and the answer has to be asked for again after any await -
	 * rendering a preview takes long enough for a scroll to bring the day back.
	 */
	isOffScreen(day: DaySection): boolean {
		if (!this.scrollEl || this.scrollEl.clientHeight === 0) return true;
		return this.distanceFromViewport(day) > 0;
	}

	/** Pixels between a day and the visible area; 0 means it is on screen. */
	private distanceFromViewport(section: DaySection): number {
		const { scrollTop, clientHeight } = this.scrollEl;
		const top = section.el.offsetTop;
		const bottom = top + section.el.offsetHeight;
		if (bottom < scrollTop) return scrollTop - bottom;
		if (top > scrollTop + clientHeight) return top - (scrollTop + clientHeight);
		return 0;
	}

	/* ------------------------------------------------------------- editors */

	/**
	 * Brings every day's mode in line with where it sits: a live editor at and
	 * around the viewport, a static preview further out.
	 *
	 * A day on screen is never touched. Swapping its body would move text the
	 * reader is looking at, and no scroll correction can undo that - a
	 * correction can only hold a fixed point, and the reader's eye is not on
	 * it. Days become editors while they are still out of sight, a screenful
	 * ahead of wherever the viewport is, which is the side scrolling brings
	 * them in from anyway. Above the viewport the height that costs is taken
	 * out of the spacer by the anchor; below it, nobody is looking.
	 *
	 * `includeVisible` is for the one moment that rule cannot hold: the view
	 * has just been built and the days on screen have never been anything but
	 * previews. The reader has not seen them yet either, so the swap is free -
	 * as long as the view re-centres afterwards.
	 */
	private updateEditors(options?: { includeVisible?: boolean }): void {
		if (!this.ready || !this.scrollEl || this.scrollEl.clientHeight === 0) return;
		const includeVisible = options?.includeVisible ?? false;
		const near = Math.max(EDITOR_MARGIN, this.scrollEl.clientHeight);
		const far = near * 2;
		const flicking = this.isFlicking();

		// Every distance is measured before anything moves: mounting an editor
		// changes the layout the remaining measurements would come from.
		const mount: { section: DaySection; distance: number }[] = [];
		const unmount: DaySection[] = [];
		for (const section of this.sections) {
			// A hidden day reports its position as 0, and needs no editor.
			if (!section.isLaidOut) {
				if (section.isEditing) unmount.push(section);
				continue;
			}
			const distance = this.distanceFromViewport(section);
			if (distance > far) {
				if (section.isEditing) unmount.push(section);
				continue;
			}
			if (section.isEditing || distance > near) continue;
			if (distance === 0 && !includeVisible) continue;
			mount.push({ section, distance });
		}
		if (!mount.length && !unmount.length) return;

		// Giving a day back to a preview is pure housekeeping; it can wait for
		// a gap in the gesture.
		if (!flicking) for (const section of unmount) void section.unmountEditor();

		// Nearest first, so what the reader is about to reach is ready first.
		mount.sort((a, b) => a.distance - b.distance);
		// An editor costs a few milliseconds to build, so they go up one or two
		// a frame - fewer while a gesture is in flight, but never none: falling
		// behind a fast scroll is what leaves a preview on screen, and once it
		// is on screen this pass will not touch it.
		let budget = flicking ? 1 : MOUNTS_PER_FRAME;
		if (includeVisible) budget = Math.max(budget, mount.filter((entry) => entry.distance === 0).length);
		const before = this.scrollEl.scrollTop;
		for (const entry of mount.slice(0, budget)) entry.section.mountEditor();
		if (mount.length) this.guardMountScroll(before);
		// A fresh editor is held at the height of the preview it replaced, so
		// this should find nothing to correct - but it is not free to assume.
		this.reanchor();
		if (mount.length > budget || (flicking && unmount.length)) this.scheduleEditors();
	}

	/**
	 * Watches the scroll position over the frames after an editor was built.
	 *
	 * A new editor asks to be scrolled into view; `JournalEditor` withdraws
	 * that request, but it reaches into Obsidian's editor to do it, so this
	 * catches what gets through. The tell is the size: the request lands in a
	 * single frame and moves the view by more than a screen, to a day that was
	 * off screen on purpose. Nothing but a scrollbar drag moves that far in one
	 * frame, and the guard is only alive for the two frames where it can
	 * happen. Running before paint, undoing it costs nothing.
	 */
	private guardMountScroll(top: number): void {
		this.guardExpected = top;
		this.guardFrames = 2;
		if (!this.guardFrame) this.guardFrame = window.requestAnimationFrame(() => this.checkMountScroll());
	}

	private checkMountScroll(): void {
		this.guardFrame = 0;
		if (!this.scrollEl || !this.ready || this.guardExpected === null) return;
		// A held pointer is a scrollbar drag or a text selection dragging the
		// view along - the one other thing that moves this far in a frame, and
		// unmistakably the reader's own doing. The guard stands down for it.
		const limit = this.pointerHeld ? Infinity : Math.max(this.scrollEl.clientHeight, 400);
		if (Math.abs(this.scrollEl.scrollTop - this.guardExpected) > limit) {
			this.scrollEl.scrollTop = this.guardExpected;
			this.lastScrollTop = this.guardExpected;
			this.guardExpected = null;
			this.updateAnchor();
			return;
		}
		// Anything smaller is the reader, and is now where the view is.
		this.guardExpected = this.scrollEl.scrollTop;
		if (--this.guardFrames > 0) this.guardFrame = window.requestAnimationFrame(() => this.checkMountScroll());
		else this.guardExpected = null;
	}

	/**
	 * Every scroll the view makes on purpose - compensating an insert, a trim,
	 * an anchor correction - is declared here, so the guard above only ever
	 * sees movement that came from somewhere else.
	 */
	private scrollMoved(): void {
		if (this.guardExpected !== null) this.guardExpected = this.scrollEl.scrollTop;
	}

	/** True while the view is moving fast enough that the reader is still travelling. */
	private isFlicking(): boolean {
		return this.scrollStep > FLICK_STEP && performance.now() - this.lastScrollAt < FLICK_IDLE;
	}

	/**
	 * Called once the scroll has been quiet for a moment. This is when work
	 * that has to write the scroll position is safe: nothing is in flight for
	 * it to cut short.
	 */
	private onSettle(): void {
		this.settleTimer = 0;
		if (!this.ready || !this.scrollEl || this.scrollEl.clientHeight === 0) return;
		this.replenishSpacer();
		this.updateEditors();
	}

	/**
	 * Tops the padding above the first day back up to its resting height. The
	 * spacer is what lets layout changes above the reader be absorbed without
	 * touching the scroll position, so a run of them can spend it - and once it
	 * is gone, corrections start writing scrollTop instead, which is what a
	 * scroll feels as a stutter. Putting it back moves the scroll position by
	 * exactly the height added, in the same task, so nothing on screen moves.
	 */
	private replenishSpacer(): void {
		const base = this.spacerBase();
		if (this.spacerHeight() >= base) return;
		const ref = this.sections.find((section) => section.isLaidOut)?.el;
		if (!ref) return;
		const before = ref.offsetTop;
		this.setSpacer(base);
		const delta = ref.offsetTop - before;
		if (delta !== 0) this.scrollEl.scrollTop += delta;
		this.lastScrollTop = this.scrollEl.scrollTop;
		this.scrollMoved();
		this.updateAnchor();
	}

	private scheduleEditors(): void {
		if (this.editorFrame) return;
		this.editorFrame = window.requestAnimationFrame(() => {
			this.editorFrame = 0;
			this.updateEditors();
		});
	}

	/* ----------------------------------------------------------- anchoring */

	/**
	 * Batches are compensated exactly at commit time, but heights can still
	 * drift afterwards: CodeMirror measures asynchronously, and images inside
	 * a note load whenever they load. The anchor covers that residue - the
	 * first day starting at or below the viewport top is pinned, and whenever
	 * layout above it changes, the difference is cancelled out before paint.
	 */
	private updateAnchor(): void {
		if (!this.scrollEl || this.scrollEl.clientHeight === 0 || !this.sections.length) {
			this.anchor = null;
			return;
		}
		const section = this.sectionNear(this.scrollEl.scrollTop);
		this.anchor = section ? { el: section.el, section, top: section.el.offsetTop } : null;
	}

	/** The day the anchor should pin for a viewport whose top sits at `position`. */
	private sectionNear(position: number): DaySection | null {
		const topOf = (index: number) => {
			const el = this.sections[index].el;
			return el.offsetParent === null ? null : el.offsetTop;
		};
		const at = findAnchorIndex(this.sections.length, topOf, position);
		if (at < 0) return null;

		// `at` is the day straddling the viewport top. Anchoring to it is
		// unstable: any height change lands below its own top edge, invisible
		// to a top-edge anchor, and shoves everything the reader sees. The
		// next day's top edge is inside the viewport; pinning that one also
		// pins the visible tail of the straddling day, so corrections extend
		// upwards, out of view.
		const top = topOf(at);
		if (top !== null && top >= position) return this.sections[at];
		for (let next = at + 1; next < this.sections.length; next++) {
			if (topOf(next) !== null) return this.sections[next];
		}
		return this.sections[at];
	}

	/**
	 * Re-pins the anchor after a residual layout change. The correction
	 * prefers resizing the spacer above the first day over writing scrollTop:
	 * wheel and momentum scrolling run on the compositor thread, and a
	 * main-thread scrollTop write commits a stale position - the deltas still
	 * in flight are lost, which the reader feels as a stutter. Resizing the
	 * spacer moves the content back under the reader without touching the
	 * scroll position at all; only what the spacer cannot absorb falls
	 * through to scrollTop.
	 */
	private reanchor(): void {
		if (!this.scrollEl || this.scrollEl.clientHeight === 0) return;
		if (!this.anchor || !this.anchor.el.isConnected || this.anchor.el.offsetParent === null) {
			this.updateAnchor();
			return;
		}

		const top = this.anchor.el.offsetTop;
		const delta = top - this.anchor.top;
		if (delta === 0) return;
		const absorbed = this.absorbWithSpacer(delta);
		this.anchor.top = top - absorbed;
		const rest = delta - absorbed;
		if (rest !== 0) {
			this.scrollEl.scrollTop += rest;
			this.scrollMoved();
		}
	}

	/**
	 * Takes as much of a layout shift as possible out of the top spacer.
	 * Returns the pixels absorbed (same sign as `delta`).
	 */
	private absorbWithSpacer(delta: number): number {
		const spacer = this.spacerHeight();
		const max = Math.max(this.spacerBase(), this.scrollEl.clientHeight);
		const next = Math.min(max, Math.max(0, spacer - delta));
		if (next === spacer) return 0;
		this.setSpacer(next);
		return spacer - next;
	}

	/** The spacer's resting height - the breathing room above the first day. */
	private spacerBase(): number {
		const height = this.scrollEl?.clientHeight ?? 0;
		return height > 0 ? Math.round(height * 0.4) : this.spacerHeight();
	}

	private spacerHeight(): number {
		if (this.spacerPx !== null) return this.spacerPx;
		const computed = parseFloat(getComputedStyle(this.daysEl).paddingTop);
		this.spacerPx = Number.isFinite(computed) ? computed : 0;
		return this.spacerPx;
	}

	private setSpacer(px: number): void {
		this.spacerPx = px;
		this.daysEl.setCssProps({ "--journal-padding-top": `${px}px` });
	}

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
			this.spacerPx = null;
			this.setSpacer(this.spacerBase());
			const section = this.sectionAt(0) ?? this.sections[0];
			this.centerOn(section, "instant");
			this.centered = true;
			this.updateEditors({ includeVisible: true });
			this.centerOn(section, "instant");
			this.onScroll();
			return;
		}
		this.reanchor();
		// A pane that changed size has a different set of days near enough to
		// the viewport to be worth an editor.
		this.scheduleEditors();
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
		this.reanchor();
		this.updateAnchor();

		if (this.scrollFrame) return;
		this.scrollFrame = window.requestAnimationFrame(() => {
			this.scrollFrame = 0;
			if (!this.scrollEl || !this.ready) return;
			this.updateHeaderLabel();
			this.updateEditors();
			if (this.needsMore("past")) void this.extend("past");
			if (this.needsMore("future")) void this.extend("future");
		});
	}

	private centerTarget(section: DaySection): number {
		return Math.max(
			0,
			section.el.offsetTop - Math.max(0, (this.scrollEl.clientHeight - section.el.offsetHeight) / 2),
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
			this.scrollMoved();
			this.updateAnchor();
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
				this.scrollMoved();
				this.updateAnchor();
				onArrive?.();
				return;
			}
			this.scrollEl.scrollTop += remaining * 0.22;
			this.scrollMoved();
			this.updateAnchor();
			this.animFrame = window.requestAnimationFrame(step);
		};
		this.animFrame = window.requestAnimationFrame(step);
	}

	goToToday(focus = false): void {
		const now = moment().startOf("day");
		const section = this.sectionAt(0);
		if (!now.isSame(this.today, "day") || !section) {
			// Midnight has passed, or today was trimmed away after a long
			// scroll - rebuilding recentres on today directly.
			void this.rebuild().then(() => {
				if (focus) this.sectionAt(0)?.focusEditor();
			});
			return;
		}
		// Focus only once the animation has arrived: focusing an editor makes
		// the browser scroll it into view, which would fight the animation.
		this.centerOn(section, "smooth", focus ? () => section.focusEditor() : undefined);
	}

	private updateHeaderLabel(): void {
		if (!this.ready || !this.headerLabelEl) return;
		// Reuses the anchor rather than measuring again - this runs every frame
		// while scrolling.
		const label = this.anchor ? this.anchor.section.date.format("MMMM YYYY") : "Journal";
		if (this.headerLabelEl.getText() !== label) this.headerLabelEl.setText(label);
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
		if (moment().startOf("day").isSame(this.today, "day")) return;
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
			section = key ? this.ensureSectionFor(this.offsetForKey(key)) : undefined;
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
		this.exhausted = { past: false, future: false };
	}

	/** Materialises a day that falls inside the range already rendered. */
	private ensureSectionFor(offset: number): DaySection | undefined {
		if (!this.ready || !this.sections.length) return undefined;
		if (offset < this.sections[0].offset || offset > this.sections[this.sections.length - 1].offset) {
			return undefined; // outside the window - the scroll loader will reach it
		}

		let at = this.sections.findIndex((section) => section.offset >= offset);
		if (at < 0) at = this.sections.length;
		if (this.sections[at]?.offset === offset) return this.sections[at];

		const section = this.createSection(offset);
		this.daysEl.insertBefore(section.el, this.sections[at]?.el ?? null);
		// The caller reloads the real content right after; the day starts
		// empty and any growth is re-pinned by the resize observer.
		this.sections.splice(at, 0, section);
		this.byPath.set(section.path, section);
		if (section.file) this.byPath.set(section.file.path, section);
		this.resizeObserver?.observe(section.el);
		this.reanchor();
		this.scheduleEditors();
		return section;
	}

	onDayFileChanged(day: DaySection, previousPath: string | null): void {
		if (previousPath) this.byPath.delete(previousPath);
		this.byPath.set(day.path, day);
		if (day.file) this.byPath.set(day.file.path, day);
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
		if (changed) this.indexPaths();
	}

	/* ------------------------------------------------------------ settings */

	async onSettingsChanged(): Promise<void> {
		if (!this.ready) return;
		// The editor kind, date format and hidden-day handling all affect
		// every day, so the honest answer is to rebuild around today.
		await this.rebuild();
	}
}
