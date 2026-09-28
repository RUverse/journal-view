import { splitLeadingH1 } from "./noteProjection";
import type { TextSelection } from "./editor";

interface Range {
	from: number;
	to: number;
}

const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[^\]\r\n]\](?:[ \t]+|$))?/;

/** Selection state belongs to one editor, and resets after a cursor move or edit. */
export class SmartSelection {
	private previous: { value: string; range: Range; ranges: Range[]; stage: number } | null = null;

	expand(value: string, selection: TextSelection, titleAlreadyHidden: boolean): TextSelection {
		const from = Math.min(selection.anchor, selection.head);
		const to = Math.max(selection.anchor, selection.head);
		const previous = this.previous;
		if (previous && previous.value === value && previous.range.from === from && previous.range.to === to) {
			previous.stage = Math.min(previous.stage + 1, previous.ranges.length - 1);
			previous.range = previous.ranges[previous.stage];
			return { anchor: previous.range.from, head: previous.range.to };
		}

		const start = titleAlreadyHidden ? 0 : (splitLeadingH1(value)?.hiddenPrefix.length ?? 0);
		const whole = { from: start, to: value.length };
		const cursor = Math.max(start, Math.min(selection.head, value.length));
		const lineStart = Math.max(start, cursor === 0 ? 0 : value.lastIndexOf("\n", cursor - 1) + 1);
		const newline = value.indexOf("\n", cursor);
		const lineEnd = newline < 0 ? value.length : newline;
		const marker = value.slice(lineStart, lineEnd).match(LIST_MARKER)?.[0].length ?? 0;
		const line = { from: lineStart + marker, to: lineEnd };

		// Fenced code can contain # characters that are not section boundaries.
		const headings: { from: number; end: number }[] = [];
		let offset = start;
		let fence: { char: string; length: number } | null = null;
		for (const text of value.slice(start).split("\n")) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
			if (fence) {
				if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
					fence = null;
				}
			} else if (match) {
				fence = { char: match[1][0], length: match[1].length };
			} else if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(text)) {
				headings.push({ from: offset, end: Math.min(value.length, offset + text.length + 1) });
			}
			offset += text.length + 1;
		}
		let section = whole;
		for (let index = 0; index < headings.length; index++) {
			const heading = headings[index];
			const next = headings[index + 1]?.from ?? value.length;
			if (heading.from <= cursor && (cursor < next || index === headings.length - 1)) {
				const body = value.slice(heading.end, next);
				const leading = body.match(/^(?:[ \t]*\n)*/)?.[0].length ?? 0;
				const trailing = body.match(/\s*$/)?.[0].length ?? 0;
				section = { from: heading.end + leading, to: Math.max(heading.end + leading, next - trailing) };
				break;
			}
		}
		const ranges = [line, section, whole];
		this.previous = { value, range: line, ranges, stage: 0 };
		return { anchor: line.from, head: line.to };
	}
}
