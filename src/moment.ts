import { moment as obsidianMoment } from "obsidian";

export type MomentUnit = "minutes" | "day" | "days" | "week" | "month";

/** The subset of Moment used by Journal View. */
export interface Moment {
	clone(): Moment;
	startOf(unit: MomentUnit): Moment;
	add(amount: number, unit: MomentUnit): Moment;
	subtract(amount: number, unit: MomentUnit): Moment;
	diff(other: Moment, unit?: MomentUnit): number;
	format(format: string): string;
	isValid(): boolean;
	isSame(other: Moment, unit?: MomentUnit): boolean;
	isBefore(other: Moment): boolean;
	isAfter(other: Moment): boolean;
	daysInMonth(): number;
	date(): number;
	date(day: number): Moment;
	hour(): number;
	minute(): number;
	second(): number;
	set(values: { hour?: number; minute?: number; second?: number; millisecond?: number }): Moment;
	valueOf(): number;
}

/**
 * Obsidian exports its bundled Moment instance with a namespace-derived type
 * that type-aware ESLint cannot safely call. Keep the runtime import from
 * Obsidian, but expose the small callable surface Journal View actually uses.
 */
type MomentFactory = (
	input?: unknown,
	formatOrStrict?: string | readonly string[] | BuiltinFormat | boolean,
	strict?: boolean,
) => Moment;

/** One of Moment's own parsers, passed where a format goes. */
interface BuiltinFormat {
	readonly builtin: true;
}

export const createMoment = obsidianMoment as unknown as MomentFactory;

/** Parses ISO 8601 dates and times, such as `2026-08-16` or `2026-08-16T14:30`. */
export const ISO_8601 = (obsidianMoment as unknown as { ISO_8601: BuiltinFormat }).ISO_8601;
