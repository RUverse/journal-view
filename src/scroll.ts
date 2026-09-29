/**
 * Scroll geometry: pure measurements, no state and no DOM writes.
 */

/**
 * An element's distance from the top of the scroller's content. A day sits
 * directly in the scroller, but the notes inside it are measured through the
 * positioned day and card around them.
 */
export function offsetTopWithin(scroller: HTMLElement, el: HTMLElement): number {
	let top = 0;
	let current: HTMLElement | null = el;
	while (current && current !== scroller) {
		top += current.offsetTop;
		current = current.offsetParent as HTMLElement | null;
	}
	return top;
}

/** Pixels between an element and the visible area; 0 means it is on screen. */
export function distanceFromViewport(scroller: HTMLElement, el: HTMLElement): number {
	const { scrollTop, clientHeight } = scroller;
	const top = offsetTopWithin(scroller, el);
	const bottom = top + el.offsetHeight;
	if (bottom < scrollTop) return scrollTop - bottom;
	if (top > scrollTop + clientHeight) return top - (scrollTop + clientHeight);
	return 0;
}

/**
 * Finds the last item whose top edge is at or above `position`.
 *
 * `topOf` returns an item's distance from the top of the scroller, or null if
 * the item is not laid out (a hidden day), in which case it is skipped rather
 * than trusted - a hidden element reports 0 and would otherwise derail the
 * search. Returns -1 when there is nothing to anchor to.
 */
export function findAnchorIndex(
	count: number,
	topOf: (index: number) => number | null,
	position: number,
): number {
	let low = 0;
	let high = count - 1;
	let best = -1;

	while (low <= high) {
		const mid = (low + high) >> 1;
		const top = topOf(mid);
		if (top === null) {
			// Nothing to compare against; look for a laid-out neighbour.
			let probe = mid + 1;
			let probeTop: number | null = null;
			while (probe <= high && (probeTop = topOf(probe)) === null) probe++;
			if (probeTop === null) {
				high = mid - 1;
				continue;
			}
			if (probeTop <= position) {
				best = probe;
				low = probe + 1;
			} else {
				high = mid - 1;
			}
			continue;
		}

		if (top <= position) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	// Everything sits below the position (the scroller is at the very top).
	if (best === -1 && count > 0) {
		for (let i = 0; i < count; i++) {
			if (topOf(i) !== null) return i;
		}
	}
	return best;
}
