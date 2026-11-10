#!/usr/bin/env node
//
// Measures how well Reflection's search finds notes, without a chat model:
// by words, by meaning with each embedding model named, and by both together
// as the plugin joins them. It asks twenty questions of the sample journal
// whose answering notes are known, and reports how many of them each way of
// searching puts among its first ten.
//
// It runs the plugin's own search (src/reflection/search.ts and semantic.ts),
// over scripts/sample-journal.md itself, so it needs no vault: only Ollama,
// and the embedding models pulled.
//
// Usage:
//   node scripts/reflection-search-eval.mjs [--models a,b] [--server url] [--plain] [--by-question]
//
// --plain also tries each model without the words it wants before a question
// and a note. --by-question lists the score of every question.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_FOLDER = join(root, "test-vault", ".reflection-spike");
const DEFAULT_MODELS = ["embeddinggemma-2:270m"];
/** Notes a search by meaning adds for each text, as tools.ts takes them. */
const NEAREST = 10;

async function loadSearch() {
	mkdirSync(RESULTS_FOLDER, { recursive: true });
	await build({
		stdin: {
			contents: [
				'export { SearchIndex, parseQuery } from "./src/reflection/search";',
				'export { SemanticIndex, embeddingPrompts, fuseRankings } from "./src/reflection/semantic";',
			].join("\n"),
			resolveDir: root,
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "node",
		outfile: join(RESULTS_FOLDER, "search-eval.mjs"),
		logLevel: "silent",
		plugins: [
			{
				name: "obsidian-stub",
				setup(setup) {
					setup.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
					setup.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
				},
			},
		],
	});
	return import("../test-vault/.reflection-spike/search-eval.mjs");
}

/** The sample journal's entries, each known by its marker: "86" for 86 days ago, "3y" for three years. */
function readEntries() {
	const entries = [];
	let entry = null;
	for (const line of readFileSync(join(root, "scripts", "sample-journal.md"), "utf8").split("\n")) {
		const marker = /^=== (\d+) (days|years) ago ===$/.exec(line);
		if (marker) {
			entry = { id: marker[2] === "years" ? `${marker[1]}y` : marker[1], properties: [], lines: [] };
			entries.push(entry);
		} else if (entry && !entry.lines.length && /^(mood|tags): /.test(line)) {
			entry.properties.push(line);
		} else if (entry) {
			entry.lines.push(line);
		}
	}
	for (const item of entries) {
		item.body = item.lines.join("\n").trim();
		// As the plugin embeds a note: what is said above its text, then the text.
		item.text = `${item.properties.join(" · ")}\n\n${item.body}`.trim();
	}
	return entries;
}

/**
 * Each question as a reader asks it, the words a chat model would search
 * for instead, and the entries that answer it.
 */
const QUESTIONS = [
	["worry", "When was I worried about losing my job?", "job, redundancy, laid off, fired, role", "86 84 81 77 74 71 66 60 51"],
	["reorg", "What happened with the reorg at work?", "reorg, reorganization, restructuring", "86 82 81 77 74 71 66 60 57 51 47 35 24"],
	["sleep", "Which nights could I not sleep, and why?", "sleep, insomnia, awake, tired", "84 74 71 60 5"],
	["happy", "When was I happiest?", "happy, joy, great day, laughed", "3 30 62 63 6 9 24 57 76 47"],
	["exercise", "How did my exercise and fitness go?", "exercise, fitness, workout, gym, run", "80 76 73 67 62 57 53 50 45"],
	["health", "What health problems did I have?", "health, doctor, pain, ill, sick", "33 20 50 53 45"],
	["sister", "How did my sister's search for a new home go?", "sister, flat, apartment, move, lease", "65 58 54 48 34 30 19 13 11 10 9 8 3"],
	["books", "What books did I read, and what did I think of them?", "book, read, novel, reading", "83 78 70 59 50 38 36 31 16 2 1"],
	["cooking", "What did I cook?", "cook, cooked, recipe, dinner, made", "82 73 35 21 20 15 3"],
	["failure", "When did something go wrong at work, and how did I take it?", "mistake, failed, went wrong, bad meeting", "5 4 2"],
	["lonely", "When did I feel lonely?", "lonely, alone, isolated", "3y 27"],
	["money", "When was I worried about money?", "money, rent, budget, afford, savings", "1y 54 71 3y"],
	["parents", "How are my parents, and when did I see them?", "parents, mum, dad, mother, father", "69 44 38"],
	["plans", "What did I say I would do?", "plan, want to, should, need to, going to", "27 15 22 19 45 69"],
	["newteam", "How was I doing when I was working on the Bookings team?", "Bookings, team, Ines", "47 36 35 24 6 5 4 2 13"],
	["teacher", "Who influenced my choice of career?", "teacher, mentor, career, inspired", "27"],
	["friend", "What did I do with friends outside work?", "friend, friends, went out, cinema, lunch", "63 21 2y 1y"],
	["bike", "What repairs did I do?", "repair, fix, fixed, broken", "22 17"],
	["impostor", "When did I doubt whether I'm good at my job?", "impostor, doubt, not good enough, fraud", "86 82 74 71"],
	["listening", "What did I learn about how to support someone who is upset?", "support, listen, comfort, upset", "11"],
].map(([id, question, keywords, answers]) => ({ id, question, keywords, answers: new Set(answers.split(" ")) }));

/** How good a ranking is: the share of the answers in its first ten, and how near the top they stand. */
function score(ranked, answers) {
	const top = ranked.slice(0, 10);
	const most = Math.min(answers.size, 10);
	let gain = 0;
	let ideal = 0;
	top.forEach((id, place) => {
		if (answers.has(id)) gain += 1 / Math.log2(place + 2);
	});
	for (let place = 0; place < most; place++) ideal += 1 / Math.log2(place + 2);
	return { recall: top.filter((id) => answers.has(id)).length / most, ndcg: gain / ideal };
}

async function embed(server, model, texts) {
	const vectors = [];
	for (let start = 0; start < texts.length; start += 16) {
		const response = await fetch(`${server}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, input: texts.slice(start, start + 16), truncate: true }),
		});
		if (!response.ok) throw new Error(`${model}: /api/embed answered ${response.status}: ${await response.text()}`);
		vectors.push(...(await response.json()).embeddings);
	}
	return vectors;
}

async function main() {
	const argv = process.argv.slice(2);
	const value = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
	const models = value("--models", DEFAULT_MODELS.join(",")).split(",");
	const server = value("--server", "http://127.0.0.1:11434").replace(/\/$/, "");
	const search = await loadSearch();
	const entries = readEntries();
	const ids = entries.map((entry) => entry.id);

	const words = new search.SearchIndex();
	for (const entry of entries) {
		words.add({ body: entry.body, extra: entry.properties.join(" ").replace(/mood:|tags:/g, "") });
	}
	const byWords = (query) => words.search(search.parseQuery(query)).hits.map((hit) => ids[hit.doc]);

	const rows = [];
	const byQuestion = [];
	const row = (name, rank, note = "") => {
		const scores = QUESTIONS.map((question) => score(rank(question), question.answers));
		const mean = (key) => scores.reduce((sum, item) => sum + item[key], 0) / scores.length;
		rows.push(`| ${name} | ${mean("recall").toFixed(2)} | ${mean("ndcg").toFixed(2)} | ${note} |`);
		byQuestion.push({ name, scores: scores.map((item) => item.ndcg) });
	};
	row("By words: the question as asked", (question) => byWords(question.question));
	row("By words: a chat model's keywords", (question) => byWords(question.keywords));

	for (const model of models) {
		for (const plain of argv.includes("--plain") ? [false, true] : [false]) {
			const prompts = plain ? { query: (text) => text, document: (text) => text } : search.embeddingPrompts(model);
			const started = performance.now();
			let vectors;
			try {
				vectors = await embed(server, model, entries.map((entry) => prompts.document(entry.text)));
			} catch (error) {
				rows.push(`| ${model} | | | ${error.message} |`);
				break;
			}
			const each = (performance.now() - started) / entries.length;
			const built = new search.SemanticIndex(model);
			entries.forEach((entry, at) => built.set(entry.id, 0, 0, [{ start: 0, end: entry.body.length }], [vectors[at]]));
			// Through a file and back, as the plugin keeps it.
			const file = built.serialize();
			const index = search.SemanticIndex.parse(file);
			const nearest = async (texts) =>
				(await embed(server, model, texts.map((text) => prompts.query(text)))).map((vector) =>
					index.search(vector, () => true).map((hit) => hit.path),
				);
			const ofQuestions = await nearest(QUESTIONS.map((question) => question.question));
			const ofKeywords = await nearest(QUESTIONS.map((question) => question.keywords));
			const at = (question) => QUESTIONS.indexOf(question);
			const name = `${model}${plain ? ", no prefixes" : ""}`;
			const note = `${vectors[0].length} numbers, ${each.toFixed(0)} ms and ${Math.round(file.byteLength / entries.length)} bytes a note`;
			row(`By meaning, ${name}: the question`, (question) => ofQuestions[at(question)], note);
			row(`By meaning, ${name}: the keywords`, (question) => ofKeywords[at(question)]);
			row(`Both, ${name}, as the plugin joins them`, (question) => {
				const fused = search.fuseRankings([
					byWords(question.keywords),
					ofKeywords[at(question)].slice(0, NEAREST),
					ofQuestions[at(question)].slice(0, NEAREST),
				]);
				return [...fused].sort((first, second) => second[1] - first[1]).map(([id]) => id);
			});
		}
	}

	console.log(`${QUESTIONS.length} questions over ${entries.length} entries.\n`);
	console.log("| Search | Answers in the first ten | nDCG@10 | |\n| --- | --- | --- | --- |");
	console.log(rows.join("\n"));
	if (argv.includes("--by-question")) {
		console.log(`\nnDCG@10 by question:\n\n| Question | ${byQuestion.map((_, at) => `[${at + 1}]`).join(" | ")} |`);
		console.log(`| --- | ${byQuestion.map(() => "---").join(" | ")} |`);
		QUESTIONS.forEach((question, at) => {
			console.log(`| ${question.id} | ${byQuestion.map((item) => item.scores[at].toFixed(2)).join(" | ")} |`);
		});
		byQuestion.forEach((item, at) => console.log(`\n[${at + 1}] ${item.name}`));
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
