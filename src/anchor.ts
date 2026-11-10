import type { DaySection } from "./day";
import { findAnchorIndex } from "./scroll";

/**
 * Blank left above the first day once the timeline has nothing left to put
 * there: enough to breathe, little enough that it reads as the top of the
 * journal rather than a screen the reader has to scroll past.
 */
export const START_GUTTER = 24;

/** The bits of the journal view the anchor needs to talk to. */
export interface AnchorHost {
	/** The scroller; its scroll position is what the anchor protects. */
	readonly scrollEl: HTMLElement;
	/** The container the top spacer is applied to. */
	readonly daysEl: HTMLElement;
	/** The live days, in order. */
	readonly sections: DaySection[];
	/** True when no further day can ever load above the first one. */
	atTimelineStart(): boolean;
	/** Declares a scroll position the anchor wrote itself. */
	onAnchorScroll(): void;
	/** A reflection being written that is at least partly in view, and the day it is on. */
	watchedReflection(): { section: DaySection; el: HTMLElement } | null;
}

/**
 * Holds the reader's place while the journal changes shape around them.
 *
 * Batches of days are compensated exactly at commit time, but heights can still
 * drift afterwards: CodeMirror measures asynchronously, and images inside a
 * note load whenever they load. The anchor covers that residue - the first day
 * starting at or below the viewport top is pinned, and whenever layout above it
 * changes, the difference is cancelled out before paint.
 *
 * Corrections come out of the spacer above the first day wherever possible.
 * Wheel and momentum scrolling run on the compositor thread, and a main-thread
 * scrollTop write commits a stale position - the deltas still in flight are
 * lost, which the reader feels as a stutter. Resizing the spacer moves the
 * content back under the reader without touching the scroll position at all;
 * only what the spacer cannot absorb falls through to scrollTop.
 *
 * A reflection being written is the exception. Pinned like any other change
 * above the day below it, it would grow upwards: the reader watching it would
 * see its text climb and its Stop button slide away from the pointer. While
 * one is in view its own top is pinned instead, so it grows downwards.
 */
export class ScrollAnchor {
	/** What is held in place: a day's card (`el` is the day), or a reflection being written. */
	private pinned: { el: HTMLElement; section: DaySection; top: number } | null = null;
	/** Current height (px) of the padding above the first day; null = untouched CSS. */
	private spacerPx: number | null = null;

	constructor(private host: AnchorHost) {}

	/** The day currently pinned, if any. */
	get section(): DaySection | null {
		return this.pinned?.section ?? null;
	}

	clear(): void {
		this.pinned = null;
	}

	/** Drops the pin if it names a day that is going away. */
	forget(section: DaySection): void {
		if (this.pinned?.section === section) this.pinned = null;
	}

	/** Re-reads the spacer from the stylesheet, after the days were rebuilt. */
	resetSpacer(): void {
		this.spacerPx = null;
	}

	/** Pins the day the viewport top currently sits at. */
	pin(): void {
		const scrollEl = this.host.scrollEl;
		if (!scrollEl || scrollEl.clientHeight === 0 || !this.host.sections.length) {
			this.pinned = null;
			return;
		}
		const watched = this.host.watchedReflection();
		if (watched) {
			this.pinned = { ...watched, top: this.topOf(watched) };
			return;
		}
		const section = this.sectionNear(scrollEl.scrollTop);
		// Date headings can move between days as notes appear or disappear. Pin
		// the card below them so those changes count as layout drift too.
		this.pinned = section ? { el: section.el, section, top: section.cardTop } : null;
	}

	/** Where a pinned element's top is: the day's card for a day, else the element's own. */
	private topOf(pinned: { el: HTMLElement; section: DaySection }): number {
		return pinned.el === pinned.section.el ? pinned.section.cardTop : pinned.section.el.offsetTop + pinned.el.offsetTop;
	}

	/** The day the anchor should pin for a viewport whose top sits at `position`. */
	sectionNear(position: number): DaySection | null {
		const sections = this.host.sections;
		const topOf = (index: number) => {
			const el = sections[index].el;
			return el.offsetParent === null ? null : el.offsetTop;
		};
		const at = findAnchorIndex(sections.length, topOf, position);
		if (at < 0) return null;

		// `at` is the day straddling the viewport top. Anchoring to it is
		// unstable: any height change lands below its own top edge, invisible
		// to a top-edge anchor, and shoves everything the reader sees. The
		// next day's top edge is inside the viewport; pinning that one also
		// pins the visible tail of the straddling day, so corrections extend
		// upwards, out of view.
		const top = topOf(at);
		if (top !== null && top >= position) return sections[at];
		for (let next = at + 1; next < sections.length; next++) {
			if (topOf(next) !== null) return sections[next];
		}
		return sections[at];
	}

	/** Re-pins after a residual layout change, cancelling out the drift. */
	settle(): void {
		const scrollEl = this.host.scrollEl;
		if (!scrollEl || scrollEl.clientHeight === 0) return;
		if (!this.pinned || !this.pinned.el.isConnected || this.pinned.el.offsetParent === null) {
			this.pin();
			return;
		}

		const top = this.topOf(this.pinned);
		const delta = top - this.pinned.top;
		if (delta !== 0) {
			const absorbed = this.absorbWithSpacer(delta);
			this.pinned.top = top - absorbed;
			const rest = delta - absorbed;
			if (rest !== 0) {
				scrollEl.scrollTop += rest;
				this.host.onAnchorScroll();
			}
		}
		// A reflection that has just started, or come into view, grows downwards from here on.
		const watched = this.host.watchedReflection();
		if (watched && watched.el !== this.pinned.el) this.pinned = { ...watched, top: this.topOf(watched) };
	}

	/**
	 * Takes as much of a layout shift as possible out of the top spacer.
	 * Returns the pixels absorbed (same sign as `delta`).
	 */
	private absorbWithSpacer(delta: number): number {
		const spacer = this.spacerHeight();
		const max = Math.max(this.spacerBase(), this.host.scrollEl.clientHeight);
		const next = Math.min(max, Math.max(0, spacer - delta));
		if (next === spacer) return 0;
		this.setSpacer(next);
		return spacer - next;
	}

	/**
	 * Returns the padding above the first day to its resting height. The spacer
	 * is what lets layout changes above the reader be absorbed without touching
	 * the scroll position, so a run of them can spend it - and once it is gone,
	 * corrections start writing scrollTop instead, which is what a scroll feels
	 * as a stutter. Putting it back moves the scroll position by exactly the
	 * height added, in the same task, so nothing on screen moves.
	 *
	 * Returns true when it did the work, so the caller can treat the resulting
	 * position as the reader's own.
	 */
	replenishSpacer(): boolean {
		// Growing is the common case. Shrinking is only ever the gutter being
		// taken back at the timeline start; a spacer that grew past its base to
		// absorb a shift is left alone, since giving that back here could cost
		// more scroll position than the reader has above them.
		if (this.spacerHeight() > this.spacerBase() && !this.atStartGutter()) return false;
		return this.restoreSpacer();
	}

	/**
	 * Hands back the blank above the first day as soon as the reader is close
	 * enough to reach it. Waiting for the scroll to stop would let them arrive
	 * at the top, see the blank, and have it collected under them; a viewport
	 * of warning is also what makes the give-back free, because the height
	 * removed is still above the viewport and the scroll position can pay for
	 * it in full.
	 */
	collapseStartSpacer(): void {
		if (!this.atStartGutter() || this.spacerHeight() <= START_GUTTER) return;
		this.restoreSpacer();
	}

	/** Moves the spacer to its resting height, compensated so nothing moves. */
	private restoreSpacer(): boolean {
		const base = this.spacerBase();
		if (this.spacerHeight() === base) return false;
		const ref = this.host.sections.find((section) => section.isLaidOut)?.el;
		if (!ref) return false;
		const before = ref.offsetTop;
		this.setSpacer(base);
		const delta = ref.offsetTop - before;
		if (delta !== 0) this.host.scrollEl.scrollTop += delta;
		this.host.onAnchorScroll();
		this.pin();
		return true;
	}

	/**
	 * The spacer's resting height - the breathing room above the first day.
	 *
	 * Room to absorb shifts is only worth having where it cannot be seen. Once
	 * the timeline has run out of days to put above the first one, and the
	 * reader is within a viewport of it, the spacer is blank they could scroll
	 * into, so it rests at a gutter instead. Both the scroll position and the
	 * first day move together whenever the spacer changes, so that distance -
	 * and with it this answer - does not change underneath the change itself.
	 */
	spacerBase(): number {
		const height = this.host.scrollEl?.clientHeight ?? 0;
		if (height <= 0) return this.spacerHeight();
		return this.atStartGutter() ? START_GUTTER : Math.round(height * 0.4);
	}

	private atStartGutter(): boolean {
		if (!this.host.atTimelineStart()) return false;
		const first = this.host.sections.find((section) => section.isLaidOut);
		if (!first) return false;
		return this.host.scrollEl.scrollTop - first.dayTop < this.host.scrollEl.clientHeight;
	}

	spacerHeight(): number {
		if (this.spacerPx !== null) return this.spacerPx;
		const computed = parseFloat(getComputedStyle(this.host.daysEl).paddingTop);
		this.spacerPx = Number.isFinite(computed) ? computed : 0;
		return this.spacerPx;
	}

	setSpacer(px: number): void {
		this.spacerPx = px;
		this.host.daysEl.setCssProps({ "--journal-padding-top": `${px}px` });
	}
}
