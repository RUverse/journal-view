import { Menu, setIcon } from "obsidian";
import type JournalViewPlugin from "../main";
import { createMoment } from "../moment";
import { summarizeScope } from "./context";
import { BUILT_IN_PRESETS, scopeLabel } from "./presets";
import type { ReflectionPreset } from "./presets";
import { NO_MODELS_MESSAGE, describeProviderError } from "./provider";

/**
 * Today's handle: a faint pill under the day's card that grows into a
 * Reflect button when hovered or focused, and opens the presets in a menu.
 * Until Ollama answers, the menu offers only the way to connect.
 */
export class ReflectButton {
	readonly el: HTMLElement;
	private button: HTMLButtonElement;
	private opening = false;

	constructor(private plugin: JournalViewPlugin) {
		this.el = createDiv({ cls: "journal-reflect" });
		this.button = this.el.createEl("button", {
			cls: "journal-reflect-button",
			attr: { "aria-label": "Reflect on your notes", "aria-haspopup": "menu" },
		});
		setIcon(this.button.createSpan({ cls: "journal-reflect-icon" }), "sparkles");
		this.button.createSpan({ cls: "journal-reflect-label", text: "Reflect" });
		this.button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.openMenu();
		});
	}

	destroy(): void {
		this.el.remove();
	}

	private async openMenu(): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		this.el.addClass("journal-reflect-busy");
		const menu = new Menu();
		try {
			const today = createMoment().startOf("day");
			const [connection, summaries] = await Promise.all([
				this.plugin
					.reflectionProvider()
					.listModels()
					.then((models) => (models.length ? null : NO_MODELS_MESSAGE))
					.catch((error: unknown) => describeProviderError(error)),
				Promise.all(
					BUILT_IN_PRESETS.map((preset) =>
						summarizeScope(this.plugin, preset.scope, today).catch(() => null),
					),
				),
			]);
			if (connection) {
				menu.addItem((item) => item.setTitle(connection).setIcon("alert-circle").setDisabled(true));
				menu.addItem((item) =>
					item
						.setTitle("Set up the connection…")
						.setIcon("plug")
						.onClick(() => this.plugin.openSettingsTab()),
				);
			} else {
				BUILT_IN_PRESETS.forEach((preset, index) => {
					const summary = summaries[index];
					menu.addItem((item) =>
						item
							.setTitle(presetTitle(preset, summary))
							.setDisabled(summary?.notes === 0)
							.onClick(() => this.plugin.reflectionRuns.start(preset, today)),
					);
				});
				menu.addSeparator();
				menu.addItem((item) =>
					item
						.setTitle("Presets and model…")
						.setIcon("settings")
						.onClick(() => this.plugin.openSettingsTab()),
				);
			}
		} finally {
			this.opening = false;
			this.el.removeClass("journal-reflect-busy");
		}
		if (!this.el.isConnected) return;
		const rect = this.button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}
}

/** "What I learned · 14 days · ~3k words". */
function presetTitle(preset: ReflectionPreset, summary: { notes: number; words: number } | null): string {
	const parts = [preset.name, scopeLabel(preset.scope)].filter(Boolean);
	if (summary && preset.scope.kind === "this-day") parts.push(summary.notes === 1 ? "1 note" : `${summary.notes} notes`);
	else if (summary) parts.push(summary.notes === 0 ? "no notes" : `~${roundWords(summary.words)} words`);
	return parts.join(" · ");
}

function roundWords(words: number): string {
	if (words < 1000) return String(Math.max(10, Math.round(words / 10) * 10));
	return `${Math.round(words / 1000)}k`;
}
