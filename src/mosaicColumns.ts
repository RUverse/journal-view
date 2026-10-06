/** A length custom property, such as `--journal-tile-size`, in pixels as computed for `element`. */
export function cssPixels(element: HTMLElement, property: string): number {
	return parseFloat(element.win.getComputedStyle(element).getPropertyValue(property)) || 0;
}

/**
 * How many of a mosaic's columns fit inside `scroller` without scrolling, and
 * within `limit` pixels, after `fixed` pixels of labels, at `step` pixels a
 * column with its gap. Always at least one; null while the scroller is not
 * laid out, as in a background tab.
 */
export function columnsThatFit(scroller: HTMLElement, fixed: number, step: number, limit = Infinity): number | null {
	const { width } = scroller.getBoundingClientRect();
	if (!width || step <= 0) return null;
	const style = scroller.win.getComputedStyle(scroller);
	const inner = Math.min(limit, width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
	// A hair of slack, so floating-point error cannot drop a column that fits exactly.
	return Math.max(1, Math.floor((inner - fixed + 0.01) / step));
}
