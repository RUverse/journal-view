#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
	cpSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "journal-view";
const DEFAULT_VAULT_NAME = "Journal View Test";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(join(scriptDir, ".."));
const sourceVault = join(root, "test-vault");
const defaultIcloudRoot = join(
	homedir(),
	"Library",
	"Mobile Documents",
	"iCloud~md~obsidian",
	"Documents",
);

function fail(message) {
	console.error(`\n${message}`);
	process.exit(1);
}

function runNpm(script) {
	try {
		execFileSync("npm", ["run", script], { cwd: root, stdio: "inherit" });
	} catch {
		fail(`npm run ${script} failed.`);
	}
}

function destinationFromArgs() {
	if (process.argv.length > 3) {
		fail("Usage: npm run deploy:ios -- [absolute-vault-path]");
	}

	const configured = process.argv[2] ?? process.env.JOURNAL_VIEW_IOS_VAULT;
	if (configured && !isAbsolute(configured)) {
		fail("The iOS test-vault path must be absolute.");
	}
	if (!configured && !existsSync(defaultIcloudRoot)) {
		fail(
			`Obsidian's iCloud folder was not found at:\n${defaultIcloudRoot}\n\n` +
				"Create or open an iCloud-based vault in Obsidian first, or pass a destination:\n" +
				"npm run deploy:ios -- /absolute/path/to/vault",
		);
	}

	return resolve(configured ?? join(defaultIcloudRoot, DEFAULT_VAULT_NAME));
}

function assertSafeDestination(destination) {
	const filesystemRoot = parse(destination).root;
	if (destination === filesystemRoot || destination === root || destination === sourceVault) {
		fail(`Refusing to deploy over unsafe destination: ${destination}`);
	}

	const fromRoot = relative(root, destination);
	if (fromRoot === ".." || (fromRoot && !fromRoot.startsWith(`..${sep}`))) {
		fail("The iOS test vault must not be the repository's parent or a path inside the repository.");
	}

	const existing = lstatSync(destination, { throwIfNoEntry: false });
	if (!existing) return;
	if (!existing.isDirectory()) fail(`The destination is not a directory: ${destination}`);
	if (readdirSync(destination).length === 0) return;

	const configDirectory = lstatSync(join(destination, ".obsidian"), { throwIfNoEntry: false });
	if (!configDirectory?.isDirectory()) {
		fail(`${destination} is not empty and is not an Obsidian vault.`);
	}
}

function copyTestVault(destination) {
	const pluginSource = join(sourceVault, ".obsidian", "plugins", PLUGIN_ID);
	const filesOwnedByIos = new Set([
		join(sourceVault, ".obsidian", "community-plugins.json"),
		join(sourceVault, ".obsidian", "workspace.json"),
		join(sourceVault, ".obsidian", "workspace-mobile.json"),
	]);
	const ignoredVaultDirectories = [join(sourceVault, ".trash"), join(sourceVault, "Untitled")];

	cpSync(sourceVault, destination, {
		force: true,
		preserveTimestamps: true,
		recursive: true,
		filter(source) {
			if (basename(source) === ".DS_Store") return false;
			if (
				ignoredVaultDirectories.some(
					(directory) => source === directory || source.startsWith(`${directory}${sep}`),
				)
			) {
				return false;
			}
			if (source === pluginSource || source.startsWith(`${pluginSource}${sep}`)) return false;
			if (filesOwnedByIos.has(source)) return false;
			// iCloud does not provide a useful deployment path for repository
			// symlinks. The plugin itself is installed as real files below.
			return !lstatSync(source).isSymbolicLink();
		},
	});
}

function installPlugin(destination) {
	const pluginDestination = join(destination, ".obsidian", "plugins", PLUGIN_ID);
	const existing = lstatSync(pluginDestination, { throwIfNoEntry: false });
	if (existing && !existing.isDirectory()) {
		rmSync(pluginDestination, { force: true, recursive: true });
	}
	mkdirSync(pluginDestination, { recursive: true });

	for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
		const source = join(root, artifact);
		if (!existsSync(source)) fail(`Build artifact is missing: ${source}`);
		copyFileSync(source, join(pluginDestination, artifact));
	}
}

function enablePlugin(destination) {
	const config = join(destination, ".obsidian", "community-plugins.json");
	let enabled = [];
	if (existsSync(config)) {
		try {
			enabled = JSON.parse(readFileSync(config, "utf8"));
		} catch (error) {
			fail(`Could not read ${config}: ${error.message}`);
		}
		if (!Array.isArray(enabled) || !enabled.every((entry) => typeof entry === "string")) {
			fail(`Expected ${config} to contain a JSON array of plugin IDs.`);
		}
	}

	if (!enabled.includes(PLUGIN_ID)) enabled.push(PLUGIN_ID);
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, `${JSON.stringify(enabled, null, "\t")}\n`);
}

const destination = destinationFromArgs();
assertSafeDestination(destination);

console.log(`Deploying Journal View to ${destination}\n`);
runNpm("test-vault");
runNpm("build");
mkdirSync(destination, { recursive: true });
copyTestVault(destination);
installPlugin(destination);
enablePlugin(destination);

console.log(`\niOS test vault deployed to:\n${destination}`);
console.log(
	`\nWait for iCloud to finish syncing, open "${basename(destination)}" on iOS, ` +
		"then restart Obsidian or toggle Journal View off and on after later deployments.",
);
