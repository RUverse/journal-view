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
//     [--max-context tokens] [--runs n] [--think] [--dry-run]
//
// Results land in test-vault/.reflection-spike/<run>/, which Obsidian hides.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { formatDate, JOURNAL_FOLDER, todayFromArgs } from "./sample-journal.mjs";

const DEFAULT_MODELS = ["llama3.1:8b", "qwen3:8b", "gemma3:4b"];
const CHARS_PER_TOKEN = 4;
const ANSWER_TOKENS = 1024;
const CONTEXT_STEP = 2048;

export const SYSTEM_PROMPT = `You read someone's private journal and write a short reflection back to them.

- Ground every point in specific entries, and cite each one with the exact link shown in its heading, such as [[2026-10-05]].
- When the notes do not cover something, say so instead of filling the gap.
- No praise, no generic advice, no therapy-speak.
- Write to the reader in the second person, in the language their notes are written in.
- Keep it to about 150–300 words unless the request asks otherwise.`;

/** Repeated after the notes, where small models still attend to it. */
export const REMINDER = "Cite only with the links exactly as written in the headings above, such as [[2026-10-05]], one date per link. Use only what the notes say. No praise, no advice, no closing summary.";

/** Mirrors the planned built-in presets. `days` counts today. */
export const PRESETS = [
	{
		id: "this-day",
		name: "This day over the years",
		scope: { kind: "this-day" },
		prompt: "These are my notes from this date in earlier years, and from today. What was I doing, worrying about and hoping for on this date each year, and what has changed since?",
		format: "Write one short paragraph per note, oldest first, each starting with that note's link. Then two or three sentences on what changed between the first note and today.",
	},
	{
		id: "what-i-learned",
		name: "What I learned",
		scope: { kind: "days", days: 14 },
		prompt: "What did I learn or realize over these two weeks?",
		format: "List up to five lessons as bullets, most important first. Each bullet is the lesson in one sentence, followed by the link of the note it comes from. Only include lessons the notes show; skip days that have none.",
	},
	{
		id: "week-in-review",
		name: "Week in review",
		scope: { kind: "days", days: 7 },
		prompt: "Review my week: the high points, the low points, and how my energy went.",
		format: "Use three short sections headed **High points**, **Low points** and **Energy**, each a few bullets with the link of the note they come from. End with one line: **A question for next week:** followed by a single question.",
	},
	{
		id: "open-loops",
		name: "Open loops",
		scope: { kind: "days", days: 30 },
		prompt: "Find plans and intentions I wrote down (\"I want to…\", \"I should…\", \"try…\") that no later note mentions again.",
		format: "Before listing a plan, look through the later notes for it, and leave it out if any later note follows it up. List each remaining plan as a bullet: the plan in a few words, the link of the note where I wrote it, and what I said about it. If there are none, say so.",
	},
	{
		id: "recurring-themes",
		name: "Recurring themes",
		scope: { kind: "days", days: 90 },
		prompt: "Which people, worries, habits and topics keep returning in these notes, and how did each one shift over time?",
		format: "Pick the three to five that come up most. For each, write its name in bold, then two or three sentences on how it changed from its first mention to its last, citing both notes. Say plainly when something stopped appearing.",
	},
	{
		id: "questions",
		name: "Questions to sit with",
		scope: { kind: "days", days: 14 },
		prompt: "Ask me three questions worth thinking about, each tied to a specific entry.",
		format: "Number the three questions. After each, give the link of the entry it comes from and one sentence on what that entry says. Do not answer the questions or give advice.",
	},
];

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
		think: argv.includes("--think"),
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
			return { date, link: `[[${date}]]`, body: stripFrontmatter(text), tags: tagsOf(text) };
		});
}

function stripFrontmatter(text) {
	return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function tagsOf(text) {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	return [...frontmatter.matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
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
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (scope.days - 1));
	const from = formatDate(start);
	return { notes: notes.filter((n) => n.date >= from && n.date <= todayKey), from, to: todayKey };
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

function formatNote(note, withYear) {
	return `### ${note.link} · ${longDate(note.date, withYear)}\n\n${demoteHeadings(note.body)}`;
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

function buildMessages(preset, selection, today, budget) {
	const withYear = selection.from.slice(0, 4) !== selection.to.slice(0, 4);
	const range = preset.scope.kind === "this-day"
		? `this date in every earlier year, and today`
		: `${longDate(selection.from, withYear)} to ${longDate(selection.to, withYear)}`;
	const system = `${SYSTEM_PROMPT}\n\nToday is ${longDate(formatDate(today), true)}.`;
	const compose = (notes) => {
		const header = `My journal notes from ${range}, oldest first (${notes.length} of ${selection.notes.length} notes):`;
		const body = notes.map((note) => formatNote(note, withYear)).join("\n\n");
		return `${header}\n\n${body}\n\n---\n\n${preset.prompt}\n\n${preset.format}\n\n${REMINDER}`;
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
		const thinks = info.capabilities.includes("thinking");
		const limit = Math.min(info.contextLength, options.maxContext);
		for (const preset of presets) {
			const selection = selectNotes(notes, preset.scope, options.today);
			const built = buildMessages(preset, selection, options.today, limit - ANSWER_TOKENS);
			const numCtx = Math.min(limit, Math.ceil((built.estimate + ANSWER_TOKENS) / CONTEXT_STEP) * CONTEXT_STEP);
			const request = {
				model,
				messages: built.messages,
				options: {
					num_ctx: numCtx,
					...(options.temperature ? { temperature: Number(options.temperature) } : {}),
				},
				...(thinks ? { think: options.think } : {}),
			};
			for (let run = 1; run <= options.runs; run++) {
				const label = `${model} · ${preset.name}${options.runs > 1 ? ` · run ${run}` : ""}`;
				process.stdout.write(`${label}: ${built.kept.length}/${selection.notes.length} notes, ~${built.estimate} tokens, num_ctx ${numCtx} … `);
				if (options.dryRun) {
					writeFileSync(join(out, `${preset.id}.prompt.md`), built.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n"));
					console.log("prompt written");
					continue;
				}
				let result;
				try {
					result = await chat(options.server, request);
				} catch (error) {
					console.log(`failed: ${error.message}`);
					rows.push({ model, preset: preset.name, run, error: error.message });
					continue;
				}
				const citations = checkCitations(result.content, built.kept);
				console.log(`${seconds(result.total)}, ${words(result.content)} words, ${citations.cited.length} cited, ${citations.unknown.length} unknown, ${citations.malformed.length} malformed`);
				const file = `${model.replace(/[^\w.-]/g, "_")}--${preset.id}${options.runs > 1 ? `--${run}` : ""}.md`;
				writeFileSync(
					join(out, file),
					[
						`# ${label}`,
						"",
						`- Read: ${built.kept.length} of ${selection.notes.length} notes, ${selection.from} to ${selection.to}`,
						`- Prompt: ~${built.estimate} tokens estimated, ${result.promptTokens ?? "?"} counted; num_ctx ${numCtx}`,
						`- Time: first words ${seconds(result.firstToken)}, total ${seconds(result.total)} (load ${seconds(result.loadMs)})`,
						`- Answer: ${words(result.content)} words, ${result.answerTokens ?? "?"} tokens${result.thinking ? `, ${words(result.thinking)} words of thinking` : ""}`,
						`- Cited: ${citations.cited.join(", ") || "none"}${citations.unknown.length ? `; not given: ${citations.unknown.join(", ")}` : ""}${citations.malformed.length ? `; malformed: ${citations.malformed.map((m) => `[[${m}]]`).join(", ")}` : ""}${citations.bareDates ? `; ${citations.bareDates} bare dates` : ""}`,
						"",
						"---",
						"",
						result.content,
						"",
					].join("\n"),
				);
				rows.push({
					model,
					preset: preset.name,
					run,
					notes: `${built.kept.length}/${selection.notes.length}`,
					estimate: built.estimate,
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
		const header = "| Model | Preset | Notes | Tokens est. / counted | First words | Total | Words | Cited | Unknown | Malformed | Bare dates |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
		const lines = rows.map((r) =>
			r.error
				? `| ${r.model} | ${r.preset} | failed: ${r.error} | | | | | | | | |`
				: `| ${r.model} | ${r.preset} | ${r.notes} | ${r.estimate} / ${r.counted ?? "?"} | ${r.firstToken} | ${r.total} | ${r.words} | ${r.cited} | ${r.unknown} | ${r.malformed} | ${r.bare} |`,
		);
		const settings = `Temperature ${options.temperature ?? "model default"}, thinking ${options.think ? "on" : "off"}.`;
		writeFileSync(join(out, "summary.md"), `${settings}\n\n${header}\n${lines.join("\n")}\n`);
	}
	console.log(`\nResults in ${out}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
