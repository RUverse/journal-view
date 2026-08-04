import { moment as obsidianMoment } from "obsidian";

export type MomentUnit = "day" | "days" | "week" | "month";

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
}

/**
 * Obsidian exports its bundled Moment instance with a namespace-derived type
 * that type-aware ESLint cannot safely call. Keep the runtime import from
 * Obsidian, but expose the small callable surface Journal View actually uses.
 */
type MomentFactory = (
	input?: unknown,
	formatOrStrict?: string | readonly string[] | boolean,
	strict?: boolean,
) => Moment;

export const createMoment = obsidianMoment as unknown as MomentFactory;
