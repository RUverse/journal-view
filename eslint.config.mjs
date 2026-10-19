import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"test-vault",
		"esbuild.config.mjs",
		"main.js",
		"package-lock.json",
		"version-bump.mjs",
		"versions.json",
	]),
	{
		languageOptions: {
			globals: globals.browser,
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mjs",
						"stylelint.config.mjs",
						"manifest.json",
						"scripts/deploy-ios-test-vault.mjs",
						"scripts/reflection-spike.mjs",
						"scripts/sample-journal.mjs",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["scripts/*.mjs"],
		languageOptions: { globals: globals.node },
		rules: {
			// These are Node-based development scripts, not code bundled into the
			// plugin. They deliberately manage a test vault's files.
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/rule-custom-message": "off",
			// Node has no `requestUrl`; its own `fetch` is the right call here.
			"no-restricted-globals": "off",
		},
	},
);
