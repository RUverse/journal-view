#!/usr/bin/env node
//
// Writes the test vault's journal - fictional daily notes for judging
// reflections - into `test-vault/Journal/` from `scripts/sample-journal.md`.
// Entries there are keyed by "days ago" and "years ago", so the notes are dated
// relative to the day this runs: the last 90 days, today, and today's date in
// earlier years.
//
// A manifest beside the vault's settings remembers what was written. Re-running
// replaces those notes, moving the journal up to today, but keeps any that were
// edited since, and never writes over a note it did not create.
//
// Usage: npm run sample-journal [-- --today YYYY-MM-DD]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = join(scriptDir, "sample-journal.md");
const vault = join(scriptDir, "..", "test-vault");
export const JOURNAL_FOLDER = join(vault, "Journal");
const manifestPath = join(vault, ".sample-journal.json");

const MARKER = /^=== (\d+) (days|years) ago ===$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fail(message) {
	console.error(message);
	process.exit(1);
}

/** Parses `--today YYYY-MM-DD`, or takes the local date. */
export function todayFromArgs(args) {
	const index = args.indexOf("--today");
	if (index === -1) {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), now.getDate());
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args[index + 1] ?? "");
	if (!match) fail("--today takes a date written YYYY-MM-DD");
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatDate(date) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function entryDate(today, count, unit) {
	if (unit === "days") {
		return new Date(today.getFullYear(), today.getMonth(), today.getDate() - count);
	}
	const year = today.getFullYear() - count;
	// 29 February falls back to the 28th in a year without it.
	const lastDay = new Date(year, today.getMonth() + 1, 0).getDate();
	return new Date(year, today.getMonth(), Math.min(today.getDate(), lastDay));
}

function parseEntries(text) {
	const entries = [];
	let current = null;
	for (const line of text.replace(/<!--[\s\S]*?-->/, "").split("\n")) {
		const marker = MARKER.exec(line);
		if (marker) {
			current = { count: Number(marker[1]), unit: marker[2], mood: "", tags: [], lines: [] };
			entries.push(current);
		} else if (current && current.lines.length === 0 && /^mood:/.test(line)) {
			current.mood = line.slice("mood:".length).trim();
		} else if (current && current.lines.length === 0 && /^tags:/.test(line)) {
			current.tags = line
				.slice("tags:".length)
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean);
		} else if (current && (current.lines.length > 0 || line.trim() !== "")) {
			current.lines.push(line);
		}
	}
	return entries;
}

function noteText(date, entry) {
	const tags = ["journal", ...entry.tags].map((tag) => `  - ${tag}`).join("\n");
	return [
		"---",
		"type: daily",
		`date: ${formatDate(date)}`,
		`weekday: ${WEEKDAYS[date.getDay()]}`,
		`mood: ${entry.mood}`,
		"tags:",
		tags,
		"---",
		"",
		entry.lines.join("\n").trim(),
		"",
	].join("\n");
}

const hash = (text) => createHash("sha256").update(text).digest("hex");

function readManifest() {
	if (!existsSync(manifestPath)) return {};
	return JSON.parse(readFileSync(manifestPath, "utf8")).files ?? {};
}

/** Removes the notes written last time, keeping any edited since. */
function removePrevious(previous) {
	const kept = [];
	for (const [name, digest] of Object.entries(previous)) {
		const path = join(JOURNAL_FOLDER, name);
		if (!existsSync(path)) continue;
		if (hash(readFileSync(path, "utf8")) === digest) rmSync(path);
		else kept.push(name);
	}
	return kept;
}

function main() {
	const today = todayFromArgs(process.argv.slice(2));
	const entries = parseEntries(readFileSync(source, "utf8"));
	if (entries.length === 0) fail(`No entries found in ${source}`);

	mkdirSync(JOURNAL_FOLDER, { recursive: true });
	const edited = removePrevious(readManifest());
	const written = {};
	const skipped = [];
	for (const entry of entries) {
		const date = entryDate(today, entry.count, entry.unit);
		const name = `${formatDate(date)}.md`;
		if (name in written) fail(`Two entries fall on ${name}`);
		const path = join(JOURNAL_FOLDER, name);
		if (existsSync(path)) {
			skipped.push(name);
			continue;
		}
		const text = noteText(date, entry);
		writeFileSync(path, text);
		written[name] = hash(text);
	}
	writeFileSync(manifestPath, `${JSON.stringify({ today: formatDate(today), files: written }, null, "\t")}\n`);

	console.log(`  wrote   ${Object.keys(written).length} sample journal notes to Journal/, up to ${formatDate(today)}`);
	if (edited.length) console.log(`  kept    ${edited.length} edited sample notes: ${edited.join(", ")}`);
	if (skipped.length) console.log(`  skipped ${skipped.length} dates that already have a note: ${skipped.join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
