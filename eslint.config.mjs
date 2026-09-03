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
						"manifest.json",
						"scripts/deploy-ios-test-vault.mjs",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["scripts/deploy-ios-test-vault.mjs"],
		languageOptions: { globals: globals.node },
		rules: {
			// This is a Node-based development script, not code bundled into the
			// mobile plugin. It deliberately manages a test vault's `.obsidian` files.
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/rule-custom-message": "off",
		},
	},
);
