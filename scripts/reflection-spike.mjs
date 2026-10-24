#!/usr/bin/env node
//
// Throwaway spike for Reflection (docs/plans/reflection.md, step 0): runs every
// preset against local Ollama models over the sample journal, and records what
// each model wrote, how long it took, and whether its citations resolve.
//
// The context is built the way src/reflection/context.ts is planned to build it,
// so the presets can be judged before any UI exists. Drop this script once
// context.ts lands.
//
// Usage:
//   npm run sample-journal
//   node scripts/reflection-spike.mjs [--models a,b] [--presets id,id]
//     [--today YYYY-MM-DD] [--folder path] [--server url] [--temperature n]
//     [--max-context tokens] [--runs n] [--think on|off] [--digest]
//     [--dry-run]
//
// Results land in test-vault/.reflection-spike/<run>/, which Obsidian hides.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { formatDate, JOURNAL_FOLDER, todayFromArgs } from "./sample-journal.mjs";

const DEFAULT_MODELS = ["llama3.1:8b", "qwen3:8b", "gemma3:4b"];
const CHARS_PER_TOKEN = 4;
const ANSWER_TOKENS = 1024;
const CONTEXT_STEP = 2048;
/** Room for reasoning and the answer, when a model thinks first. */
const THINKING_TOKENS = 12288;

export const SYSTEM_PROMPT = `You read someone's private journal and write a short reflection back to them.

- Ground every point in specific entries, and cite each one with the exact link shown in its heading, such as [[2026-10-05]].
- When the notes do not cover something, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the request asks otherwise.`;

/** Repeated after the notes, where small models still attend to it. */
export const REMINDER = "Write to me as \"you\". Cite only with the links exactly as written in the headings above, such as [[2026-10-05]], one date per link. Use only what the notes say. No praise, no advice, no closing summary.";

/**
 * Mirrors the planned built-in presets. `days` counts today unless the range
 * ends `beforeToday`. `digest` reads the range in parts of that many days
 * first, when the spike runs with --digest; the spike found it no better.
 */
export const PRESETS = [
	{
		id: "this-day",
		name: "This day over the years",
		scope: { kind: "this-day" },
		prompt: "These are my notes from this date in earlier years, and from today. What was I doing, worrying about and hoping for on this date each year, and what has changed since?",
		format: "Write one short paragraph per note, oldest first, starting with the note's link alone. Keep each paragraph to its own year: who was around me and how near they were, what I worried about, and what I hoped for. Save every comparison for two or three closing sentences that set the first note's hopes against today's note.",
	},
	{
		id: "what-i-learned",
		name: "What I learned",
		scope: { kind: "days", days: 14 },
		prompt: "What did I learn or realize over these two weeks?",
		format: "Answer with one to three bullets and nothing else. Each is the lesson, said to me as \"you\", then the link of the note it comes from. A note counts when it states a realization, or shows me doing something differently and it working. A good or hard day on its own does not count.",
	},
	{
		id: "week-in-review",
		name: "Week in review",
		scope: { kind: "days", days: 7 },
		prompt: "Review my week: the high points, the low points, and how my energy went.",
		format: "Use three short sections. **High points** and **Low points** are a few bullets each, with the link of the note they come from. **Energy** is two or three sentences following it day by day from the first note to today, using each note's mood and words, citing each day. End with one line: **A question for next week:** followed by a single question about a worry or decision that the last note still leaves open.",
	},
	{
		id: "open-loops",
		name: "Open loops",
		scope: { kind: "days", days: 30, beforeToday: true },
		prompt: "Find the plans and intentions I wrote down (\"I want to…\", \"I should…\", \"try…\"), and check whether any later note follows each one up.",
		format: "A plan is something I said I would do; leave out lessons, things already done, and other people's plans. Write **Still open** first: each plan no later note follows up, the link of the note where I wrote it, and what I said about it. Then **Followed up**: each plan with the link of the note where I wrote it and the link of the later note that follows it up. Put each plan under one heading only, and under Followed up only if you can give that later link. If a heading would be empty, write \"None.\" under it.",
	},
	{
		id: "recurring-themes",
		name: "Recurring themes",
		scope: { kind: "days", days: 90 },
		prompt: "Which people, worries, habits and topics keep returning in these notes, and how did each one shift over time?",
		format: "Pick the three to five that come up most. For each, write its name in bold, then two or three sentences on how it changed, with the link of the first note that mentions it and the link of the last note that mentions it. When that last note is before {twoWeeksAgo}, write that it stopped appearing after that note.",
		digest: 14,
	},
	{
		id: "questions",
		name: "Questions to sit with",
		scope: { kind: "days", days: 14 },
		prompt: "Ask me three questions worth thinking about, each tied to a specific entry.",
		format: "Number the three questions. For each, give the link of the entry, one sentence on what it says, then the question. Ask about something the entry leaves open in my own life (a choice, a tension, a change it does not explain), never something it already answers, what something says, suggests or reveals about me, or what I will do next. Do not answer the questions or give advice.",
	},
];

/** The first pass of a digest: what each part of a long range is about. */
const DIGEST_PROMPT = "List the people, worries, habits and topics in these notes. One bullet each: the name in bold, then the link of every note that mentions it, then a few words on what those notes say about it, in order. Use only the links in the headings above.";

function parseArgs(argv) {
	const value = (flag, fallback) => {
		const index = argv.indexOf(flag);
		return index === -1 ? fallback : argv[index + 1];
	};
	return {
		models: value("--models", DEFAULT_MODELS.join(",")).split(","),
		presets: value("--presets", PRESETS.map((p) => p.id).join(",")).split(","),
		today: todayFromArgs(argv),
		folder: value("--folder", JOURNAL_FOLDER),
		server: value("--server", "http://127.0.0.1:11434").replace(/\/$/, ""),
		temperature: value("--temperature", undefined),
		maxContext: Number(value("--max-context", "32768")),
		runs: Number(value("--runs", "1")),
		think: value("--think", "off"),
		digest: argv.includes("--digest"),
		dryRun: argv.includes("--dry-run"),
	};
}

// --- Reading notes -----------------------------------------------------------

function readNotes(folder) {
	return readdirSync(folder)
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
		.sort()
		.map((name) => {
			const date = basename(name, ".md");
			const text = readFileSync(join(folder, name), "utf8");
			return { date, link: `[[${date}]]`, body: stripFrontmatter(text), properties: propertiesOf(text) };
		});
}

function stripFrontmatter(text) {
	return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** Reads simple YAML: `key: value` lines and `key:` followed by `  - item` lines. */
function propertiesOf(text) {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const properties = {};
	let list = null;
	for (const line of frontmatter.split("\n")) {
		const item = /^\s+- (.+)$/.exec(line);
		if (item && list) {
			list.push(item[1].trim());
			continue;
		}
		const pair = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		if (pair[2] === "") {
			list = [];
			properties[pair[1]] = list;
		} else {
			list = null;
			properties[pair[1]] = pair[2].trim();
		}
	}
	return properties;
}

function parseDate(date) {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y, m - 1, d);
}

function selectNotes(notes, scope, today) {
	const todayKey = formatDate(today);
	if (scope.kind === "this-day") {
		const monthDay = todayKey.slice(5);
		const notesOnDate = notes.filter((n) => n.date.slice(5) === monthDay && n.date <= todayKey);
		return { notes: notesOnDate, from: notesOnDate[0]?.date ?? todayKey, to: todayKey };
	}
	// A range before today ends yesterday: today's plans cannot be open loops yet.
	const end = scope.beforeToday ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1) : today;
	const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (scope.days - 1));
	const from = formatDate(start);
	const to = formatDate(end);
	return { notes: notes.filter((n) => n.date >= from && n.date <= to), from, to };
}

// --- Context -----------------------------------------------------------------

function longDate(date, withYear) {
	return parseDate(date).toLocaleDateString("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		...(withYear ? { year: "numeric" } : {}),
	});
}

/** Pushes a note's own headings below the `###` that introduces the note. */
function demoteHeadings(body) {
	return body.replace(/^(#{1,3}) /gm, (_, hashes) => "#".repeat(Math.min(6, hashes.length + 3)) + " ");
}

/**
 * One line of the note's properties, leaving out what tells the model nothing:
 * empty values, values every note in the range shares (`type: daily`, the tag
 * `journal`), and values that restate the note's own date.
 */
function propertyLine(note, notes) {
	const shared = (key, value) => notes.every((other) => [other.properties[key]].flat().includes(value));
	const restatesDate = (value) =>
		value === note.date || value.toLowerCase() === longDate(note.date, false).split(" ")[0].replace(",", "").toLowerCase();
	const parts = [];
	for (const [key, raw] of Object.entries(note.properties)) {
		const values = [raw].flat().filter((value) => value && !restatesDate(value) && (notes.length < 2 || !shared(key, value)));
		if (values.length) parts.push(`${key}: ${values.join(", ")}`);
	}
	return parts.join(" · ");
}

function formatNote(note, withYear, notes) {
	const properties = propertyLine(note, notes);
	const heading = `### ${note.link} · ${longDate(note.date, withYear)}`;
	return `${heading}\n${properties ? `${properties}\n` : ""}\n${demoteHeadings(note.body)}`;
}

const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Keeps `count` notes spread evenly across the range, always the first and last. */
function spreadEvenly(notes, count) {
	if (count >= notes.length) return notes;
	if (count <= 1) return notes.slice(-1);
	const picked = new Set();
	for (let i = 0; i < count; i++) picked.add(Math.round((i * (notes.length - 1)) / (count - 1)));
	return notes.filter((_, index) => picked.has(index));
}

function buildMessages(preset, selection, today, budget, task = `${preset.prompt}\n\n${preset.format}\n\n${REMINDER}`) {
	const withYear = selection.from.slice(0, 4) !== selection.to.slice(0, 4);
	const range = preset.scope.kind === "this-day"
		? `this date in every earlier year, and today`
		: `${longDate(selection.from, withYear)} to ${longDate(selection.to, withYear)}`;
	const system = `${SYSTEM_PROMPT}\n\nToday is ${longDate(formatDate(today), true)}.`;
	// Models cannot count back from today, so the cut-off date is written in.
	const twoWeeksAgo = longDate(formatDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 14)), withYear);
	task = task.replaceAll("{twoWeeksAgo}", twoWeeksAgo);
	const compose = (notes) => {
		const header = `My journal notes from ${range}, oldest first (${notes.length} of ${selection.notes.length} notes):`;
		const body = notes.map((note) => formatNote(note, withYear, selection.notes)).join("\n\n");
		return `${header}\n\n${body}\n\n---\n\n${task}`;
	};

	let kept = selection.notes;
	let user = compose(kept);
	while (kept.length > 1 && estimateTokens(system + user) > budget) {
		kept = spreadEvenly(selection.notes, kept.length - 1);
		user = compose(kept);
	}
	return {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		kept,
		estimate: estimateTokens(system + user),
	};
}

// --- Ollama ------------------------------------------------------------------

async function showModel(server, model) {
	const response = await fetch(`${server}/api/show`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!response.ok) throw new Error(`${model}: /api/show answered ${response.status}`);
	const info = await response.json();
	const lengthKey = Object.keys(info.model_info ?? {}).find((key) => key.endsWith(".context_length"));
	return {
		capabilities: info.capabilities ?? [],
		contextLength: lengthKey ? info.model_info[lengthKey] : 8192,
	};
}

async function chat(server, request) {
	const started = performance.now();
	const response = await fetch(`${server}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...request, stream: true }),
	});
	if (!response.ok || !response.body) {
		throw new Error(`/api/chat answered ${response.status}: ${await response.text()}`);
	}
	let content = "";
	let thinking = "";
	let firstToken = null;
	let final = {};
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const part = JSON.parse(line);
			if (part.error) throw new Error(part.error);
			thinking += part.message?.thinking ?? "";
			if (part.message?.content) {
				firstToken ??= performance.now() - started;
				content += part.message.content;
			}
			if (part.done) final = part;
		}
	}
	return {
		content,
		thinking,
		firstToken,
		total: performance.now() - started,
		promptTokens: final.prompt_eval_count,
		answerTokens: final.eval_count,
		doneReason: final.done_reason,
		loadMs: final.load_duration ? final.load_duration / 1e6 : 0,
	};
}

// --- Checking ----------------------------------------------------------------

function checkCitations(text, kept) {
	const given = new Set(kept.map((note) => note.date));
	const cited = [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim());
	const unique = [...new Set(cited)];
	const links = unique.filter((target) => /^\d{4}-\d{2}-\d{2}$/.test(target));
	return {
		cited: links,
		unknown: links.filter((date) => !given.has(date)),
		malformed: unique.filter((target) => !/^\d{4}-\d{2}-\d{2}$/.test(target)),
		bareDates: [...text.matchAll(/(?<!\[\[)\b\d{4}-\d{2}-\d{2}\b(?!\]\])/g)].length,
	};
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;
const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);

// --- Main --------------------------------------------------------------------

function numCtxFor(estimate, limit, thinking) {
	const room = thinking ? THINKING_TOKENS : ANSWER_TOKENS;
	return Math.min(limit, Math.ceil((estimate * 1.1 + room) / CONTEXT_STEP) * CONTEXT_STEP);
}

/** One preset on one model: a single pass, or a digest of each part and then the answer. */
async function reflect(options, model, info, preset, selection) {
	const thinking = info.capabilities.includes("thinking") && options.think === "on";
	const limit = Math.min(info.contextLength, options.maxContext);
	const send = (messages, estimate) =>
		chat(options.server, {
			model,
			messages,
			options: {
				num_ctx: numCtxFor(estimate, limit, thinking),
				...(options.temperature ? { temperature: Number(options.temperature) } : {}),
			},
			...(info.capabilities.includes("thinking") ? { think: thinking } : {}),
		});

	if (!(options.digest && preset.digest)) {
		const built = buildMessages(preset, selection, options.today, limit - ANSWER_TOKENS);
		return { ...(await send(built.messages, built.estimate)), kept: built.kept, estimate: built.estimate, thinking: thinking ? "on" : "off", passes: 1 };
	}

	const started = performance.now();
	const parts = [];
	for (let first = parseDate(selection.from); formatDate(first) <= selection.to; ) {
		const last = new Date(first.getFullYear(), first.getMonth(), first.getDate() + preset.digest - 1);
		const from = formatDate(first);
		const to = formatDate(last) < selection.to ? formatDate(last) : selection.to;
		const part = { notes: selection.notes.filter((n) => n.date >= from && n.date <= to), from, to };
		if (part.notes.length) {
			const built = buildMessages(preset, part, options.today, limit - ANSWER_TOKENS, DIGEST_PROMPT);
			const result = await send(built.messages, built.estimate);
			parts.push({ ...part, text: result.content.trim() });
		}
		first = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
	}
	const digests = parts.map((part) => `#### ${longDate(part.from, false)} to ${longDate(part.to, false)}\n\n${part.text}`).join("\n\n");
	const system = `${SYSTEM_PROMPT}\n\nToday is ${longDate(formatDate(options.today), true)}.`;
	const user = `What my journal notes from ${longDate(selection.from, false)} to ${longDate(selection.to, false)} are about, in parts of ${preset.digest} days, oldest first. Each link is a note.\n\n${digests}\n\n---\n\n${preset.prompt}\n\n${preset.format}\n\n${REMINDER}`;
	const estimate = estimateTokens(system + user);
	const final = await send([{ role: "system", content: system }, { role: "user", content: user }], estimate);
	const firstPass = final.total - (final.firstToken ?? 0);
	return {
		...final,
		firstToken: final.firstToken == null ? null : performance.now() - started - firstPass,
		total: performance.now() - started,
		kept: selection.notes,
		estimate,
		thinking: thinking ? "on" : "off",
		passes: parts.length + 1,
		digests,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const notes = readNotes(options.folder);
	if (notes.length === 0) throw new Error(`No notes in ${options.folder}; run npm run sample-journal`);
	const presets = options.presets.map((id) => {
		const preset = PRESETS.find((p) => p.id === id);
		if (!preset) throw new Error(`Unknown preset ${id}`);
		return preset;
	});

	const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const out = join(JOURNAL_FOLDER, "..", ".reflection-spike", runId);
	mkdirSync(out, { recursive: true });
	const rows = [];

	for (const model of options.models) {
		const info = options.dryRun ? { capabilities: [], contextLength: 131072 } : await showModel(options.server, model);
		for (const preset of presets) {
			const selection = selectNotes(notes, preset.scope, options.today);
			if (options.dryRun) {
				const built = buildMessages(preset, selection, options.today, options.maxContext - ANSWER_TOKENS);
				writeFileSync(join(out, `${preset.id}.prompt.md`), built.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n"));
				console.log(`${preset.name}: ${built.kept.length}/${selection.notes.length} notes, ~${built.estimate} tokens, prompt written`);
				continue;
			}
			for (let run = 1; run <= options.runs; run++) {
				const label = `${model} · ${preset.name}${options.runs > 1 ? ` · run ${run}` : ""}`;
				process.stdout.write(`${label}: ${selection.notes.length} notes … `);
				let result;
				try {
					result = await reflect(options, model, info, preset, selection);
				} catch (error) {
					console.log(`failed: ${error.message}`);
					rows.push({ model, preset: preset.name, run, error: error.message });
					continue;
				}
				const citations = checkCitations(result.content, result.kept);
				const how = `${result.passes > 1 ? `${result.passes} passes` : "1 pass"}, thinking ${result.thinking}`;
				console.log(`${how}, ${seconds(result.total)}, ${words(result.content)} words, ${citations.cited.length} cited, ${citations.unknown.length} unknown, ${citations.malformed.length} malformed`);
				const file = `${model.replace(/[^\w.-]/g, "_")}--${preset.id}${options.runs > 1 ? `--${run}` : ""}.md`;
				writeFileSync(
					join(out, file),
					[
						`# ${label}`,
						"",
						`- Read: ${result.kept.length} of ${selection.notes.length} notes, ${selection.from} to ${selection.to}; ${how}`,
						`- Prompt: ~${result.estimate} tokens estimated, ${result.promptTokens ?? "?"} counted${result.passes > 1 ? " (last pass)" : ""}`,
						`- Time: first words ${seconds(result.firstToken)}, total ${seconds(result.total)} (load ${seconds(result.loadMs)})`,
						`- Answer: ${words(result.content)} words, ${result.answerTokens ?? "?"} tokens generated, stopped by ${result.doneReason ?? "?"}`,
						`- Cited: ${citations.cited.join(", ") || "none"}${citations.unknown.length ? `; not given: ${citations.unknown.join(", ")}` : ""}${citations.malformed.length ? `; malformed: ${citations.malformed.map((m) => `[[${m}]]`).join(", ")}` : ""}${citations.bareDates ? `; ${citations.bareDates} bare dates` : ""}`,
						"",
						"---",
						"",
						result.content,
						"",
						...(result.digests ? ["", "<!-- first pass", "", result.digests, "", "-->", ""] : []),
					].join("\n"),
				);
				rows.push({
					model,
					preset: preset.name,
					run,
					how,
					estimate: result.estimate,
					counted: result.promptTokens,
					firstToken: seconds(result.firstToken),
					total: seconds(result.total),
					words: words(result.content),
					cited: citations.cited.length,
					unknown: citations.unknown.length,
					malformed: citations.malformed.length,
					bare: citations.bareDates,
				});
			}
		}
	}

	if (!options.dryRun) {
		const header = "| Model | Preset | How | Tokens est. / counted | First words | Total | Words | Cited | Unknown | Malformed | Bare dates |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
		const lines = rows.map((r) =>
			r.error
				? `| ${r.model} | ${r.preset} | failed: ${r.error} | | | | | | | | |`
				: `| ${r.model} | ${r.preset} | ${r.how} | ${r.estimate} / ${r.counted ?? "?"} | ${r.firstToken} | ${r.total} | ${r.words} | ${r.cited} | ${r.unknown} | ${r.malformed} | ${r.bare} |`,
		);
		const settings = `Temperature ${options.temperature ?? "model default"}, thinking ${options.think}${options.digest ? ", digest on" : ""}.`;
		writeFileSync(join(out, "summary.md"), `${settings}\n\n${header}\n${lines.join("\n")}\n`);
	}
	console.log(`\nResults in ${out}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
