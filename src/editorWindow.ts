import type { DaySection } from "./day";
import { distanceFromViewport } from "./scroll";

/**
 * How far beyond the viewport (px) days are kept as live editors. At least a
 * screenful, so a day is an editor well before the reader can scroll to it and
 * click. Days beyond twice this go back to a preview; the gap between the two
 * keeps a day sitting on the boundary from flipping back and forth.
 */
const EDITOR_MARGIN = 800;
/** Editors mounted per frame, so a burst of them cannot stall a scroll. */
const MOUNTS_PER_FRAME = 2;

/** The bits of the journal view the editor window needs to talk to. */
export interface EditorWindowHost {
	readonly scrollEl: HTMLElement;
	/** The live days, in order. */
	readonly sections: DaySection[];
	/** True once a window of days is built and measurable. */
	isReady(): boolean;
	/** True while the reader is moving fast enough to feel a stall. */
	isFlicking(): boolean;
	/** True while a pointer is held in the scroller (scrollbar, selection). */
	isPointerHeld(): boolean;
	/** Cancels residual layout drift against the pinned day. */
	settleAnchor(): void;
	/** The guard put the view back; `top` is where the reader now is. */
	onGuardScroll(top: number): void;
}

/**
 * Decides which days are live editors and which are static previews, and keeps
 * a freshly built editor from dragging the view along with it.
 */
export class EditorWindow {
	private frame = 0;
	private guardFrame = 0;
	/** Scroll position a freshly mounted editor must not move the view away from. */
	private guardExpected: number | null = null;
	private guardFrames = 0;

	constructor(private host: EditorWindowHost) {}

	destroy(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.frame = 0;
		if (this.guardFrame) window.cancelAnimationFrame(this.guardFrame);
		this.guardFrame = 0;
		this.guardExpected = null;
	}

	schedule(): void {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			this.update();
		});
	}

	/**
	 * Every scroll the view makes on purpose - compensating an insert, a trim,
	 * an anchor correction - is declared here, so the guard below only ever
	 * sees movement that came from somewhere else.
	 */
	declareScroll(): void {
		if (this.guardExpected !== null) this.guardExpected = this.host.scrollEl.scrollTop;
	}

	/** Mounts a find target under the same scroll guard used by window updates. */
	mountForFind(section: DaySection): boolean {
		if (section.isEditing) return false;
		const before = this.host.scrollEl.scrollTop;
		section.mountEditor();
		this.guardMountScroll(before);
		return true;
	}

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
	update(options?: { includeVisible?: boolean }): void {
		const scrollEl = this.host.scrollEl;
		if (!this.host.isReady() || !scrollEl || scrollEl.clientHeight === 0) return;
		const includeVisible = options?.includeVisible ?? false;
		const near = Math.max(EDITOR_MARGIN, scrollEl.clientHeight);
		const far = near * 2;
		const flicking = this.host.isFlicking();

		// Every distance is measured before anything moves: mounting an editor
		// changes the layout the remaining measurements would come from.
		const mount: { section: DaySection; distance: number }[] = [];
		const unmount: DaySection[] = [];
		for (const section of this.host.sections) {
			// A hidden day reports its position as 0, and needs no editor.
			if (!section.isLaidOut) {
				if (section.isEditing) unmount.push(section);
				continue;
			}
			const distance = distanceFromViewport(scrollEl, section.el);
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
		const before = scrollEl.scrollTop;
		for (const entry of mount.slice(0, budget)) entry.section.mountEditor();
		if (mount.length) this.guardMountScroll(before);
		// A fresh editor is held at the height of the preview it replaced, so
		// this should find nothing to correct - but it is not free to assume.
		this.host.settleAnchor();
		if (mount.length > budget || (flicking && unmount.length)) this.schedule();
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
		const scrollEl = this.host.scrollEl;
		if (!scrollEl || !this.host.isReady() || this.guardExpected === null) return;
		// A held pointer is a scrollbar drag or a text selection dragging the
		// view along - the one other thing that moves this far in a frame, and
		// unmistakably the reader's own doing. The guard stands down for it.
		const limit = this.host.isPointerHeld() ? Infinity : Math.max(scrollEl.clientHeight, 400);
		if (Math.abs(scrollEl.scrollTop - this.guardExpected) > limit) {
			const expected = this.guardExpected;
			scrollEl.scrollTop = expected;
			this.guardExpected = null;
			this.host.onGuardScroll(expected);
			return;
		}
		// Anything smaller is the reader, and is now where the view is.
		this.guardExpected = scrollEl.scrollTop;
		if (--this.guardFrames > 0) this.guardFrame = window.requestAnimationFrame(() => this.checkMountScroll());
		else this.guardExpected = null;
	}
}
