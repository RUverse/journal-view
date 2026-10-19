import { FuzzySuggestModal } from "obsidian";
import type { App } from "obsidian";
import { BUILT_IN_PRESETS, scopeLabel } from "./presets";
import type { ReflectionPreset } from "./presets";

/** The presets, for the Create reflection command: the menu's choices, from the keyboard. */
export class ReflectionPresetModal extends FuzzySuggestModal<ReflectionPreset> {
	constructor(
		app: App,
		private onChoose: (preset: ReflectionPreset) => void,
	) {
		super(app);
		this.setPlaceholder("Reflect on your notes…");
	}

	getItems(): ReflectionPreset[] {
		return [...BUILT_IN_PRESETS];
	}

	getItemText(preset: ReflectionPreset): string {
		const scope = scopeLabel(preset.scope);
		return scope ? `${preset.name} · ${scope}` : preset.name;
	}

	onChooseItem(preset: ReflectionPreset): void {
		this.onChoose(preset);
	}
}
