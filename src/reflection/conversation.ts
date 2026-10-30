import type { ChatMessage } from "./provider";

/**
 * A reflection's conversation as its note keeps it: the answer, then each
 * follow-up as a plain quote of the question followed by its answer, which
 * reads well in Obsidian and can be read back into a conversation:
 *
 *     > Say more about the second point
 *
 *     The answer…
 *
 * An answer can quote the reader's notes the same way, so a quote only
 * starts a follow-up when the note's `follow-ups` property records its
 * question. Notes written before that kept each question in a
 * `> [!question]` callout, which still counts.
 */
export interface Conversation {
	/** The reflection itself, before any follow-up. */
	answer: string;
	followUps: FollowUp[];
}

export interface FollowUp {
	question: string;
	answer: string;
}

/** The first line of a follow-up's callout, as notes kept them before plain quotes. */
const CALLOUT_LINE = /^>\s*\[!question\][+-]?[ \t]*(.*)$/i;

/** Text compared without its spacing, so a quote rewrapped in the note still matches its question. */
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Splits a reflection note's body into the answer and its follow-ups.
 * `questions` are the follow-ups the note records, in order; a quote that
 * matches none of them belongs to the answer around it.
 */
export function parseConversation(body: string, questions: readonly string[] = []): Conversation {
	const lines = body.split(/\r?\n/);
	const wanted = questions.map(normalized);
	/** The first recorded question not found yet; one that was edited away is skipped. */
	let next = 0;
	const answer: string[] = [];
	const followUps: Array<{ question: string; lines: string[] }> = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const callout = CALLOUT_LINE.exec(line);
		const startsQuote = line.startsWith(">") && (index === 0 || lines[index - 1].trim() === "");
		if (callout || (startsQuote && next < wanted.length)) {
			let end = index + 1;
			while (end < lines.length && lines[end].startsWith(">")) end++;
			const quoted = lines.slice(index, end).map((quotedLine) => quotedLine.replace(/^>\s?/, ""));
			if (callout) quoted[0] = callout[1];
			const question = quoted.join("\n").trim();
			const found = callout ? -1 : wanted.indexOf(normalized(question), next);
			if (callout || found >= 0) {
				if (found >= 0) next = found + 1;
				followUps.push({ question, lines: [] });
				index = end - 1;
				continue;
			}
		}
		(followUps.length ? followUps[followUps.length - 1].lines : answer).push(line);
	}
	return {
		answer: answer.join("\n").trim(),
		followUps: followUps.map((followUp) => ({ question: followUp.question, answer: followUp.lines.join("\n").trim() })),
	};
}

/** A follow-up's question as a plain quote, without its answer. */
export function questionQuote(question: string): string {
	return question
		.trim()
		.split(/\r?\n/)
		.map((line) => `> ${line}`.trimEnd())
		.join("\n");
}

/** A follow-up as it is added to the end of its reflection's note. */
export function followUpMarkdown(question: string, answer: string): string {
	return `${questionQuote(question)}\n\n${answer.trim()}`;
}

/**
 * The turns after a reflection's first request: its answer, each follow-up
 * and its answer, then `question`, which is asked now, followed by `closing`:
 * the shape of the answer and the rules again, which small models forget
 * otherwise.
 */
export function conversationMessages(conversation: Conversation, question: string, closing: string): ChatMessage[] {
	const messages: ChatMessage[] = [{ role: "assistant", content: conversation.answer }];
	for (const followUp of conversation.followUps) {
		messages.push({ role: "user", content: followUp.question }, { role: "assistant", content: followUp.answer });
	}
	messages.push({ role: "user", content: `${question}\n\n${closing}` });
	return messages;
}
