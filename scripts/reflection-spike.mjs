#!/usr/bin/env node
//
// Runs Reflection against the sample journal through local Ollama models, to
// tune it and judge its answers (docs/plans/reflection.md). It asks questions
// of the reader's own and the built-in presets, and records every tool call,
// its arguments, what it returned, the answer, timings and whether the
// citations resolve.
//
// It runs the plugin's own code: src/reflection/tools.ts and what it imports
// touch nothing of Obsidian's, so they are bundled here as they are and given
// the test vault's notes as their journal. Only the Ollama calls are this
// script's own, since the plugin's go through Obsidian.
//
// Usage:
//   npm run sample-journal
//   node scripts/reflection-spike.mjs [--models a,b] [--questions id,id]
//     [--today YYYY-MM-DD] [--folder path] [--server url] [--max-context tokens]
//     [--exclude-tag tag] [--runs n] [--label name] [--timeout seconds]
//     [--semantic [embedding-model]]
//   node scripts/reflection-spike.mjs --ask "What did I cook in August?" [--shape "One line per dish."]
//     [--follow-up "And in September?"]
//   node scripts/reflection-spike.mjs --list
//   node scripts/reflection-spike.mjs --call search_journal '{"query": "running"}'
//
// --ask puts a question of your own, in the shape given or the one for
// questions, and --follow-up then asks its answer a follow-up, as the card does. --list names the built-in questions. --call runs one tool as a
// model would and prints what it returns, without a model. --semantic turns
// search by meaning on, with the embedding model named or the suggested one;
// its index is kept beside the results. Results of the other runs land in
// test-vault/.reflection-spike/<run>/, which Obsidian hides.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JOURNAL_FOLDER } from "./sample-journal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where runs are recorded, which Obsidian hides. */
const RESULTS_FOLDER = join(root, "test-vault", ".reflection-spike");
const DEFAULT_MODELS = ["gemma4:26b"];
/** The most an answer may run to, as ollama.ts caps it. */
const ANSWER_LIMIT = 2048;

// --- The plugin's code ----------------------------------------------------------

/**
 * Bundles the engine as the plugin builds it, with Obsidian's module stubbed
 * out, since none of it is called, into the folder the results go to.
 */
async function loadEngine() {
	mkdirSync(RESULTS_FOLDER, { recursive: true });
	await build({
		stdin: {
			contents: [
				'export { reflectWithTools } from "./src/reflection/tools";',
				'export { BUILT_IN_PRESETS, QUESTION_FORMAT } from "./src/reflection/presets";',
				'export { ProviderError } from "./src/reflection/provider";',
				'export { propertyLine, repairCitations } from "./src/reflection/context";',
				'export { sharedAcross } from "./src/reflection/tools";',
				'export { SUGGESTED_EMBEDDING_MODEL } from "./src/reflection/provider";',
				'export { SemanticIndex, embeddingPrompts, updateIndex } from "./src/reflection/semantic";',
			].join("\n"),
			resolveDir: root,
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "node",
		outfile: join(RESULTS_FOLDER, "engine.mjs"),
		logLevel: "silent",
		plugins: [
			{
				name: "obsidian-stub",
				setup(setup) {
					setup.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
					setup.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
						contents:
							"module.exports = new Proxy({}, { get: (_, name) => () => { throw new Error(`obsidian.${String(name)} is not available outside Obsidian`); } });",
						loader: "js",
					}));
				},
			},
		],
	});
	return import("../test-vault/.reflection-spike/engine.mjs");
}

// --- The journal ----------------------------------------------------------------

const normalizeTag = (value) => value.trim().replace(/^#+/, "").replace(/\/+$/g, "").toLocaleLowerCase();

/** Simple YAML: `key: value` lines and `key:` followed by `  - item` lines. */
function propertiesOf(text) {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const properties = new Map();
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
			properties.set(pair[1], list);
		} else {
			list = null;
			if (pair[2].trim()) properties.set(pair[1], [pair[2].trim()]);
		}
	}
	for (const [key, values] of properties) if (!values.length) properties.delete(key);
	return properties;
}

/** The notes of a folder as the plugin's journal.ts gives the vault's: a `JournalSource`. */
function readJournal(folder, excludeTag) {
	const bodies = new Map();
	const notes = readdirSync(folder)
		.filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name))
		.sort()
		.map((name) => {
			const base = basename(name, ".md");
			const text = readFileSync(join(folder, name), "utf8").replace(/\r\n?/g, "\n");
			const properties = propertiesOf(text);
			const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
			const inline = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1]);
			const path = `Journal/${name}`;
			bodies.set(path, body);
			const stat = statSync(join(folder, name));
			return {
				key: base.slice(0, 10),
				path,
				mtime: Math.round(stat.mtimeMs),
				size: stat.size,
				link: `[[${base}]]`,
				name: base,
				properties,
				tags: [...new Set([...(properties.get("tags") ?? []), ...inline].map(normalizeTag))],
			};
		})
		.filter((note) => !excludeTag || !note.tags.some((tag) => tag === excludeTag || tag.startsWith(`${excludeTag}/`)));
	return { notes, body: async (note) => bodies.get(note.path) ?? null };
}

/**
 * Search by meaning over a journal, as the plugin's semanticStore.ts gives the
 * vault's: the index is kept in a file beside the results, brought up to
 * date before each search, and asked for the notes nearest each text.
 */
function searchByMeaning(engine, journal, server, model) {
	const file = join(RESULTS_FOLDER, `index-${model.replace(/[^\w.-]/g, "_")}.bin`);
	let index = null;
	const embed = async (texts) => {
		const response = await fetch(`${server}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, input: texts, truncate: true }),
		});
		if (!response.ok) throw new Error(`${model}: /api/embed answered ${response.status}: ${await response.text()}`);
		return (await response.json()).embeddings;
	};
	return async (texts, signal, onStatus) => {
		if (!index) {
			const saved = existsSync(file) ? engine.SemanticIndex.parse(readFileSync(file).buffer.slice(0)) : null;
			index = saved?.model === model ? saved : new engine.SemanticIndex(model);
		}
		const shared = engine.sharedAcross(journal.notes);
		const notes = journal.notes.map((note) => ({
			path: note.path,
			mtime: note.mtime,
			size: note.size,
			heading: engine.propertyLine(note, shared),
			body: () => journal.body(note),
		}));
		await engine.updateIndex(index, notes, embed, {
			signal,
			progress: (done, total) => onStatus(`Indexing your notes… ${done} of ${total}`),
			save: async () => {
				writeFileSync(file, new Uint8Array(index.serialize()));
				index.dirty = false;
			},
		});
		const prompts = engine.embeddingPrompts(model);
		const vectors = await embed(texts.map((text) => prompts.query(text)));
		const allowed = new Set(journal.notes.map((note) => note.path));
		return vectors.map((vector) => index.search(vector, (path) => allowed.has(path)));
	};
}

// --- Ollama ---------------------------------------------------------------------

async function showModel(server, model) {
	const response = await fetch(`${server}/api/show`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!response.ok) throw new Error(`${model}: /api/show answered ${response.status}`);
	const info = await response.json();
	const lengthKey = Object.keys(info.model_info ?? {}).find((key) => key.endsWith(".context_length"));
	const capabilities = info.capabilities ?? [];
	return {
		name: model,
		tools: capabilities.includes("tools"),
		thinking: capabilities.includes("thinking"),
		contextLength: lengthKey ? info.model_info[lengthKey] : null,
	};
}

/** The conversation in Ollama's format, as ollama.ts writes it. */
function ollamaMessages(messages) {
	return messages.map((message) => {
		if (message.role === "tool") return { role: "tool", content: message.content, tool_name: message.toolName };
		if (message.role === "assistant" && message.toolCalls?.length) {
			return {
				role: "assistant",
				content: message.content,
				tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
			};
		}
		return { role: message.role, content: message.content };
	});
}

function argumentsOf(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Not JSON: no arguments.
		}
	}
	return {};
}

const seconds = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);

/**
 * A provider as the engine asks for one, over `fetch`, which keeps a record
 * of every round: what was sent, what came back, and how long it took.
 */
function recordingProvider(server, timeout, ProviderError, log) {
	return {
		async chat(request) {
			// What the tools returned for the round before shows up here, as the next request's last messages.
			const previous = log.rounds[log.rounds.length - 1];
			if (previous?.calls.length) {
				const results = request.messages.slice(-previous.calls.length);
				for (const [index, call] of previous.calls.entries()) call.content = results[index]?.content ?? "";
			} else if (previous && request.messages[request.messages.length - 1]?.role === "user") {
				previous.sentBack = request.messages[request.messages.length - 1].content;
			}
			const started = performance.now();
			let text = "";
			let final = {};
			const toolCalls = [];
			let cut = false;
			try {
				const response = await fetch(`${server}/api/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: request.model,
						messages: ollamaMessages(request.messages),
						options: { num_ctx: request.numCtx, num_predict: ANSWER_LIMIT },
						think: false,
						stream: true,
						...(request.tools ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
					}),
					signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
				});
				if (!response.ok || !response.body) {
					const body = await response.text();
					if (/does not support tools/i.test(body)) throw new ProviderError("no-tools", body);
					throw new Error(`/api/chat answered ${response.status}: ${body}`);
				}
				let buffer = "";
				const decoder = new TextDecoder();
				const take = (line) => {
					if (!line.trim()) return;
					const part = JSON.parse(line);
					if (part.error) throw new Error(part.error);
					for (const call of part.message?.tool_calls ?? []) {
						if (typeof call?.function?.name === "string") {
							toolCalls.push({ name: call.function.name, arguments: argumentsOf(call.function.arguments) });
						}
					}
					if (part.done) final = part;
					if (part.message?.content) {
						text += part.message.content;
						request.onText(part.message.content);
					}
				};
				for await (const chunk of response.body) {
					buffer += decoder.decode(chunk, { stream: true });
					let newline;
					while ((newline = buffer.indexOf("\n")) !== -1) {
						take(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
					}
				}
				take(buffer);
			} catch (error) {
				// Stopped by the engine, as ollama.ts reports it: an answer it was going to drop.
				if (!request.signal.aborted) throw error;
				cut = true;
			}
			const round = {
				tools: Boolean(request.tools),
				total: performance.now() - started,
				loadMs: final.load_duration ? final.load_duration / 1e6 : 0,
				promptTokens: final.prompt_eval_count ?? null,
				answerTokens: final.eval_count ?? null,
				doneReason: final.done_reason ?? null,
				text,
				calls: toolCalls.map((call) => ({ call, content: "" })),
				sentBack: null,
				cut,
			};
			log.rounds.push(round);
			if (cut) throw new ProviderError("aborted", "Stopped");
			// As ollama.ts does: an answer cut off before a word or a call is a failure, not an empty answer.
			if (!text.trim() && !toolCalls.length && round.doneReason === "length") {
				throw new ProviderError("failed", "The model stopped before it wrote an answer");
			}
			return { text, promptTokens: round.promptTokens, doneReason: round.doneReason, streamed: true, toolCalls };
		},
	};
}

/** A provider that makes the calls it is given, one round each, then answers: runs a tool without a model. */
function scriptedProvider(calls, log) {
	let round = 0;
	return {
		async chat(request) {
			const last = request.messages[request.messages.length - 1];
			if (round > 0 && last.role === "tool") log.results.push(last.content);
			const call = calls[round++];
			return call
				? { text: "", promptTokens: null, doneReason: "stop", streamed: false, toolCalls: [call] }
				: { text: "Done.", promptTokens: null, doneReason: "stop", streamed: false, toolCalls: [] };
		},
	};
}

// --- Checking -------------------------------------------------------------------

/** The links an answer cites, against the notes the run read or was shown. */
function checkCitations(text, sources, journal) {
	const read = new Set(sources.map((source) => source.link.slice(2, -2)));
	const known = new Set(journal.notes.map((note) => note.link.slice(2, -2)));
	const cited = [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => match[1].trim()))];
	return {
		cited,
		unread: cited.filter((link) => !read.has(link) && known.has(link)),
		unknown: cited.filter((link) => !known.has(link)),
	};
}

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// --- Questions ------------------------------------------------------------------

/** Questions whose answers the sample journal plants; the answer key is in docs/plans/reflection.md. */
const QUESTIONS = [
	{ id: "running", text: "When did I stop running, and why?" },
	{ id: "mina", text: "What did I write about Mina?" },
	{ id: "reorg", text: "What happened with the reorg at work?" },
	{ id: "this-date", text: "What was I doing on this date in past years?" },
	{ id: "farahani", text: "Did I ever write to Mr. Farahani?" },
	{ id: "lisbon", text: "How did my trip to Lisbon go?" },
	{ id: "learned", text: "What did I learn in the last two weeks?" },
	{ id: "headaches", text: "What did the doctor say about my headaches, and did it help?" },
	{ id: "money", text: "When was I worried about money, and what did I do about it?" },
	{ id: "bookshelf", text: "Did I ever build the bookshelf for the hallway?" },
	{ id: "last-month-theo", text: "What did Theo and I do together over the last month?" },
	{ id: "august", text: "What were the best days of August?" },
	// Questions whose notes share few of their words, which a search by meaning is for.
	{ id: "job-worry", text: "When was I worried about losing my job, and how did it end?" },
	{ id: "career", text: "Who influenced my choice of career?" },
	{ id: "support", text: "What did I learn about how to support someone who is upset?" },
	{ id: "health", text: "What health problems did I have?" },
	{ id: "bookings", text: "How was I doing when I was working on the Bookings team?" },
];

function parseArgs(argv) {
	const value = (flag, fallback) => {
		const index = argv.indexOf(flag);
		return index === -1 ? fallback : argv[index + 1];
	};
	const call = argv.indexOf("--call");
	const semantic = argv.indexOf("--semantic");
	// The model's name follows the flag, unless the next thing is another flag or the end.
	const embedding = semantic !== -1 && argv[semantic + 1] && !argv[semantic + 1].startsWith("--") ? argv[semantic + 1] : "";
	return {
		semantic: semantic !== -1,
		embedding,
		models: value("--models", DEFAULT_MODELS.join(",")).split(","),
		questions: value("--questions", "").split(",").filter(Boolean),
		today: value("--today", ""),
		folder: value("--folder", JOURNAL_FOLDER),
		server: value("--server", "http://127.0.0.1:11434").replace(/\/$/, ""),
		maxContext: Number(value("--max-context", "32768")),
		excludeTag: normalizeTag(value("--exclude-tag", "")),
		runs: Number(value("--runs", "1")),
		label: value("--label", ""),
		timeout: Number(value("--timeout", "240")) * 1000,
		list: argv.includes("--list"),
		ask: value("--ask", ""),
		shape: value("--shape", ""),
		followUp: value("--follow-up", ""),
		call: call === -1 ? null : { name: argv[call + 1], arguments: JSON.parse(argv[call + 2] ?? "{}") },
	};
}

function transcript(label, question, model, limit, result, error, log, citations, total) {
	const lines = [`# ${label}`, "", `Question: ${question.text}`, ""];
	if (question.format) lines.push(`Answer shape: ${question.format}`, "");
	lines.push(
		`- Model: ${model}; context ${limit}`,
		`- Rounds: ${log.rounds.length}; total ${seconds(total)}`,
		`- Read in full: ${result?.sources.map((source) => source.key).join(", ") || "none"}`,
		`- Cited: ${citations.cited.join(", ") || "none"}; not read in full ${citations.unread.length}${citations.unread.length ? ` (${citations.unread.join(", ")})` : ""}, not in the journal ${citations.unknown.length}${citations.unknown.length ? ` (${citations.unknown.join(", ")})` : ""}`,
		"",
	);
	for (const [index, round] of log.rounds.entries()) {
		lines.push(
			`## Round ${index + 1}${round.tools ? "" : " (no tools)"}`,
			"",
			`${seconds(round.total)} (load ${seconds(round.loadMs)}), prompt ${round.promptTokens ?? "?"} tokens, ${round.answerTokens ?? "?"} generated, ${round.cut ? "cut short" : (round.doneReason ?? "?")}`,
			"",
		);
		if (round.text.trim()) lines.push("Text:", "", `> ${round.text.trim().split("\n").join("\n> ")}`, "");
		if (round.sentBack) lines.push(`Sent back with: ${round.sentBack}`, "");
		for (const { call, content } of round.calls) {
			lines.push(`### ${call.name}(${JSON.stringify(call.arguments)})`, "", `${content.length} characters`, "", "```text", content, "```", "");
		}
	}
	lines.push("## Answer", "", result?.text ?? "(none)", "");
	if (error) lines.push("## Error", "", error.message, "");
	return lines.join("\n");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const engine = await loadEngine();
	const presets = engine.BUILT_IN_PRESETS.map((preset) => ({
		id: `preset:${preset.id}`,
		text: preset.prompt,
		format: preset.format,
	}));
	const all = [...QUESTIONS, ...presets];
	if (options.list) {
		for (const question of all) console.log(`${question.id.padEnd(26)} ${question.text}`);
		return;
	}
	const journal = readJournal(options.folder, options.excludeTag);
	if (!journal.notes.length) throw new Error(`No notes in ${options.folder}; run npm run sample-journal`);
	// The sample journal's own today is its last note, so its planted dates line up.
	const today = options.today || journal.notes[journal.notes.length - 1].key;
	if (options.semantic) {
		journal.nearest = searchByMeaning(engine, journal, options.server, options.embedding || engine.SUGGESTED_EMBEDDING_MODEL);
	}

	if (options.call) {
		const log = { results: [] };
		await engine.reflectWithTools({
			journal,
			provider: scriptedProvider([options.call], log),
			model: { name: "none", tools: true, thinking: false, contextLength: 131072 },
			question: "",
			format: "",
			today,
			maxContext: options.maxContext,
			signal: new AbortController().signal,
			onStatus: (line) => console.log(`[${line}]\n`),
			onText: () => {},
			onReset: () => {},
		});
		console.log(log.results.join("\n\n"));
		return;
	}

	const questions = options.ask
		? [{ id: "ask", text: options.ask, format: options.shape || undefined, followUp: options.followUp || undefined }]
		: options.questions.length
			? options.questions.map((id) => {
					const question = all.find((candidate) => candidate.id === id);
					if (!question) throw new Error(`Unknown question ${id}; --list names them`);
					return question;
				})
			: all;
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${options.label ? `-${options.label}` : ""}`;
	const out = join(RESULTS_FOLDER, runId);
	mkdirSync(out, { recursive: true });
	const rows = [];

	for (const model of options.models) {
		const info = await showModel(options.server, model);
		for (const question of questions) {
			for (let run = 1; run <= options.runs; run++) {
				const label = `${model} · ${question.id}${options.runs > 1 ? ` · run ${run}` : ""}`;
				process.stdout.write(`${label} … `);
				const log = { rounds: [] };
				const statuses = [];
				const started = performance.now();
				let result = null;
				let error = null;
				try {
					const ask = (followUp) =>
						engine.reflectWithTools({
							journal,
							provider: recordingProvider(options.server, options.timeout, engine.ProviderError, log),
							model: info,
							question: question.text,
							format: question.format ?? engine.QUESTION_FORMAT,
							followUp,
							today,
							maxContext: options.maxContext,
							signal: new AbortController().signal,
							onStatus: (line) => statuses.push(line),
							onText: () => {},
							onReset: () => {},
						});
					result = await ask();
					result.text = engine.repairCitations(result.text, result.sources);
					if (question.followUp) {
						// As the card asks one: the answer so far, and the notes it drew on.
						log.rounds.push({ tools: false, total: 0, loadMs: 0, text: `(follow-up) ${question.followUp}`, calls: [], doneReason: "asked" });
						statuses.push("follow-up");
						const first = result;
						result = await ask({
							conversation: { answer: first.text, followUps: [] },
							question: question.followUp,
							sources: first.sources.map((source) => source.link),
						});
						result.text = engine.repairCitations(result.text, result.sources);
					}
				} catch (caught) {
					error = caught;
				}
				const total = performance.now() - started;
				const citations = checkCitations(result?.text ?? "", result?.sources ?? [], journal);
				const file = `${model.replace(/[^\w.-]/g, "_")}--${question.id.replace(/[^\w.-]/g, "_")}${options.runs > 1 ? `--${run}` : ""}.md`;
				const limit = Math.min(info.contextLength ?? 8192, options.maxContext);
				writeFileSync(join(out, file), transcript(label, question, model, limit, result, error, log, citations, total));
				if (error) {
					console.log(`failed: ${error.message}`);
					rows.push({ model, question: question.id, error: error.message });
					continue;
				}
				console.log(`${log.rounds.length} rounds, ${seconds(total)}; ${statuses.join("; ")}; read ${result.sources.length}, cited ${citations.cited.length} (${citations.unread.length} unread, ${citations.unknown.length} unknown)`);
				rows.push({
					model,
					question: question.id,
					rounds: log.rounds.length,
					calls: statuses.join("; "),
					read: result.sources.length,
					total: seconds(total),
					words: wordCount(result.text),
					cited: citations.cited.length,
					unread: citations.unread.length,
					unknown: citations.unknown.length,
				});
			}
		}
	}

	const header =
		"| Model | Question | Rounds | Calls | Read | Time | Words | Cited | Not read in full | Not in the journal |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
	const lines = rows.map((row) =>
		row.error
			? `| ${row.model} | ${row.question} | failed: ${row.error.replace(/\|/g, "/")} | | | | | | | |`
			: `| ${row.model} | ${row.question} | ${row.rounds} | ${row.calls.replace(/\|/g, "/")} | ${row.read} | ${row.total} | ${row.words} | ${row.cited} | ${row.unread} | ${row.unknown} |`,
	);
	const settings = `Today ${today}, max context ${options.maxContext}${options.excludeTag ? `, excluding #${options.excludeTag}` : ""}.`;
	writeFileSync(join(out, "summary.md"), `${settings}\n\n${header}\n${lines.join("\n")}\n`);
	console.log(`\nResults in ${out}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
