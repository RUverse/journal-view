/** Pointer and touch gestures that mean the reader has taken over scrolling. */
const READER_SCROLL_EVENTS = ["wheel", "touchmove", "pointerdown"] as const;
/** Keyboard gestures that can move the journal or its focused editor. */
const READER_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const READER_SCROLL_LISTENER: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Watches the ways a reader can take over a programmatic scroll hold.
 * Returns one cleanup so cursor reveal and view centring use exactly the same
 * definition of reader input.
 */
export function listenForReaderScrollIntent(target: EventTarget, callback: () => void): () => void {
	const onScroll = (): void => callback();
	const onKeydown = (event: Event): void => {
		if (event instanceof KeyboardEvent && READER_SCROLL_KEYS.has(event.key)) callback();
	};
	for (const type of READER_SCROLL_EVENTS) target.addEventListener(type, onScroll, READER_SCROLL_LISTENER);
	target.addEventListener("keydown", onKeydown, READER_SCROLL_LISTENER);
	return () => {
		for (const type of READER_SCROLL_EVENTS) target.removeEventListener(type, onScroll, READER_SCROLL_LISTENER);
		target.removeEventListener("keydown", onKeydown, READER_SCROLL_LISTENER);
	};
}
