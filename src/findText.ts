export interface FindRange {
	from: number;
	to: number;
}

/** The expression matching `query` literally, or null for an empty query. */
export function literalExpression(query: string, caseSensitive: boolean): RegExp | null {
	if (!query) return null;
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(escaped, caseSensitive ? "gu" : "giu");
}

/** Returns non-overlapping literal matches in source order. */
export function findLiteralRanges(text: string, query: string, caseSensitive: boolean): FindRange[] {
	const expression = literalExpression(query, caseSensitive);
	return expression ? rangesOf(text, expression) : [];
}

/** Every match of a global `expression` in `text`, in source order. */
export function rangesOf(text: string, expression: RegExp): FindRange[] {
	const ranges: FindRange[] = [];
	for (const match of text.matchAll(expression)) {
		if (match.index === undefined) continue;
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}
	return ranges;
}

/** How many times a global `expression` matches `text`, without keeping the matches. */
export function countMatches(text: string, expression: RegExp): number {
	expression.lastIndex = 0;
	let count = 0;
	while (expression.exec(text)) count++;
	return count;
}
