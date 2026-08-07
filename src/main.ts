import { MarkdownView, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { DailyNoteResolver } from "./dailyNotes";
import { createMoment } from "./moment";
import type { Moment } from "./moment";
import { DAY_KEY_FORMAT, DailyNoteIndex } from "./noteIndex";
import {
	DEFAULT_SETTINGS,
	JournalViewSettingTab,
	JournalViewSettings,
	LEGACY_FULL_HEADER_FORMAT,
	MONTH_SEPARATOR_DAY_FORMAT,
	clampSaveDelay,
} from "./settings";
import type { DaySortDirection } from "./settings";
import { JournalView, VIEW_TYPE_JOURNAL } from "./view";

export default class JournalViewPlugin extends Plugin {
	settings: JournalViewSettings = { ...DEFAULT_SETTINGS };
	daily!: DailyNoteResolver;
	index!: DailyNoteIndex;
	private dailyNoteActions = new Map<MarkdownView, HTMLElement>();
	/** Target dates handed to journal views before Obsidian constructs them. */
	private initialDates = new Map<WorkspaceLeaf, Moment>();

	private notifyViews = debounce(
		() => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
				const view = leaf.view;
				if (view instanceof JournalView) void view.onSettingsChanged();
			}
		},
		400,
		true,
	);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.daily = new DailyNoteResolver(this.app, () => this.settings);
		this.index = new DailyNoteIndex(this.app, this.daily);

		// The index has to be registered before any view, so it is already up to
		// date by the time a view reacts to the same vault event.
		this.app.workspace.onLayoutReady(() => {
			this.index.rebuild();
			this.syncDailyNoteActions();
		});
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) this.index.handleCreate(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.index.handleDelete(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.index.handleDelete(oldPath);
				if (file instanceof TFile) this.index.handleCreate(file);
				this.syncDailyNoteActions();
			}),
		);
		this.registerEvent(this.app.workspace.on("file-open", () => this.syncDailyNoteActions()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncDailyNoteActions()));
		this.register(() => this.clearDailyNoteActions());

		this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));

		this.addRibbonIcon("notebook", "Open journal", () => void this.activateView());

		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "open-new-tab",
			name: "Open in a new tab",
			callback: () => void this.activateView(true),
		});

		this.addCommand({
			id: "go-to-today",
			name: "Go to today",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(JournalView);
				if (!view) return false;
				if (!checking) view.goToToday(true);
				return true;
			},
		});

		this.addSettingTab(new JournalViewSettingTab(this.app, this));
	}

	onunload(): void {
		// Views clean themselves up in onClose; make sure nothing typed in the
		// last moment is lost when the plugin is disabled or reloaded.
		const flushes: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
			const view = leaf.view;
			if (view instanceof JournalView) flushes.push(view.flushAll());
		}
		void Promise.all(flushes).catch((error: unknown) => {
			console.error("Journal View: could not flush all pending edits during unload", error);
		});
	}

	async activateView(forceNewTab = false, date?: Moment): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL);

		let leaf: WorkspaceLeaf;
		let created = false;
		if (existing.length > 0 && !forceNewTab) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf(true);
			created = true;
			if (date) this.initialDates.set(leaf, date.clone().startOf("day"));
			try {
				await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
			} finally {
				// The view normally consumes this during construction; also clear it
				// when construction fails so a leaf is never left holding stale state.
				this.initialDates.delete(leaf);
			}
		}
		await workspace.revealLeaf(leaf);
		if (date && !created && leaf.view instanceof JournalView) leaf.view.goToDate(date, true);
	}

	/** Consumed by a JournalView constructor so its first build uses the target date. */
	consumeInitialDate(leaf: WorkspaceLeaf): Moment | undefined {
		const date = this.initialDates.get(leaf);
		this.initialDates.delete(leaf);
		return date;
	}

	/** Keeps a native view-header action on every open daily-note pane. */
	private syncDailyNoteActions(): void {
		const open = new Set<MarkdownView>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			open.add(view);

			const isDailyNote = !!view.file && this.index.keyForPath(view.file.path) !== null;
			const action = this.dailyNoteActions.get(view);
			if (!isDailyNote) {
				action?.remove();
				this.dailyNoteActions.delete(view);
				return;
			}
			if (action?.isConnected) return;
			action?.remove();

			const added = view.addAction("notebook", "Open this day in journal", () => {
				void this.openDailyNoteInJournal(view);
			});
			this.dailyNoteActions.set(view, added);
		});

		for (const [view, action] of this.dailyNoteActions) {
			if (open.has(view)) continue;
			action.remove();
			this.dailyNoteActions.delete(view);
		}
	}

	private clearDailyNoteActions(): void {
		for (const action of this.dailyNoteActions.values()) action.remove();
		this.dailyNoteActions.clear();
	}

	private async openDailyNoteInJournal(view: MarkdownView): Promise<void> {
		const key = view.file ? this.index.keyForPath(view.file.path) : null;
		if (!key) return;
		const date = createMoment(key, DAY_KEY_FORMAT, true);
		if (!date.isValid()) return;
		await this.activateView(false, date);
	}

	async loadSettings(): Promise<void> {
		const saved: unknown = await this.loadData();
		if (!isRecord(saved)) {
			this.settings = { ...DEFAULT_SETTINGS };
			return;
		}
		this.settings = {
			dateFormat: stringSetting(saved.dateFormat, DEFAULT_SETTINGS.dateFormat),
			folder: stringSetting(saved.folder, DEFAULT_SETTINGS.folder),
			templatePath: stringSetting(saved.templatePath, DEFAULT_SETTINGS.templatePath),
			headerFormat: headerFormatSetting(saved.headerFormat, typeof saved.showMonthSeparators === "boolean"),
			showMonthSeparators: booleanSetting(
				saved.showMonthSeparators,
				DEFAULT_SETTINGS.showMonthSeparators,
			),
			groupDaysByYear: booleanSetting(
				saved.groupDaysByYear,
				booleanSetting(saved.showYearSeparators, DEFAULT_SETTINGS.groupDaysByYear),
			),
			saveDelay: saveDelaySetting(saved.saveDelay),
			richEditor: booleanSetting(saved.richEditor, DEFAULT_SETTINGS.richEditor),
			focusTodayOnOpen: booleanSetting(saved.focusTodayOnOpen, DEFAULT_SETTINGS.focusTodayOnOpen),
			hideEmptyDays: booleanSetting(saved.hideEmptyDays, DEFAULT_SETTINGS.hideEmptyDays),
			daySortDirection: daySortDirectionSetting(saved.daySortDirection),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncDailyNoteActions();
		this.notifyViews();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringSetting(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Migrates the interim header defaults once, while preserving later choices. */
function headerFormatSetting(value: unknown, hasGroupingSetting: boolean): string {
	const format = stringSetting(value, DEFAULT_SETTINGS.headerFormat);
	if (!hasGroupingSetting && (format === LEGACY_FULL_HEADER_FORMAT || format === MONTH_SEPARATOR_DAY_FORMAT)) {
		return DEFAULT_SETTINGS.headerFormat;
	}
	return format;
}

function saveDelaySetting(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.saveDelay;
	return clampSaveDelay(value);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function daySortDirectionSetting(value: unknown): DaySortDirection {
	return value === "descending" ? "descending" : DEFAULT_SETTINGS.daySortDirection;
}
