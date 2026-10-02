import obsidianmd from "stylelint-config-obsidianmd";

// The CSS rules of Obsidian's plugin review. The review reports only the rules
// the config adds itself, so leave out the stylistic `stylelint-config-standard`
// it builds on.
const { extends: _standard, ...review } = obsidianmd;

/** @type {import("stylelint").Config} */
export default review;
