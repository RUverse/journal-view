import type { ChatMessage } from "./provider";

/**
 * A reflection's conversation as its note keeps it: the answer, then each
 * follow-up as a question callout followed by its answer, which reads well
 * in Obsidian and can be read back into a conversation:
 *
 *     > [!question] Say more about the second point
 *
 *     The answer…
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

/** The first line of a follow-up's callout, holding the question. */
const QUESTION_LINE = /^>\s*\[!question\][+-]?[ \t]*(.*)$/i;

/** Splits a reflection note's body into the answer and its follow-ups. */
export function parseConversation(body: string): Conversation {
	const lines = body.split(/\r?\n/);
	const answer: string[] = [];
	const followUps: Array<{ question: string; lines: string[] }> = [];
	for (let index = 0; index < lines.length; index++) {
		const match = QUESTION_LINE.exec(lines[index]);
		if (!match) {
			(followUps.length ? followUps[followUps.length - 1].lines : answer).push(lines[index]);
			continue;
		}
		// A question of several lines goes on inside the callout.
		const question = [match[1]];
		while (index + 1 < lines.length && lines[index + 1].startsWith(">")) {
			question.push(lines[++index].replace(/^>\s?/, ""));
		}
		followUps.push({ question: question.join("\n").trim(), lines: [] });
	}
	return {
		answer: answer.join("\n").trim(),
		followUps: followUps.map((followUp) => ({ question: followUp.question, answer: followUp.lines.join("\n").trim() })),
	};
}

/** A follow-up's callout, without its answer. */
export function questionCallout(question: string): string {
	const [first, ...rest] = question.trim().split(/\r?\n/);
	return [`> [!question] ${first}`, ...rest.map((line) => `> ${line}`.trimEnd())].join("\n");
}

/** A follow-up as it is added to the end of its reflection's note. */
export function followUpMarkdown(question: string, answer: string): string {
	return `${questionCallout(question)}\n\n${answer.trim()}`;
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
