/**
 * Serialises writes for a single note, newest value wins.
 *
 * The point is that a value handed to `submit` is captured immediately and is
 * no longer tied to whatever produced it. A day's editor can be torn down the
 * instant after submitting, mid-write, and the queued text still reaches disk.
 *
 * `write` reports success; a failed write keeps its value queued so the next
 * submit retries it rather than silently dropping the edit.
 */
export class SaveQueue {
	private pending: string | null = null;
	private inFlight: Promise<void> | null = null;

	constructor(private write: (value: string) => Promise<boolean>) {}

	get hasPending(): boolean {
		return this.pending !== null || this.inFlight !== null;
	}

	/** Queues `value`; resolves once the queue has drained. */
	submit(value: string): Promise<void> {
		this.pending = value;
		if (!this.inFlight) {
			this.inFlight = this.run().finally(() => {
				this.inFlight = null;
			});
		}
		return this.inFlight;
	}

	/** Resolves once nothing is queued or in flight. */
	async settled(): Promise<void> {
		while (this.inFlight) await this.inFlight;
	}

	private async run(): Promise<void> {
		while (this.pending !== null) {
			const value = this.pending;
			this.pending = null;

			const ok = await this.write(value);
			if (!ok) {
				// Hold the newest text for a later attempt, but stop looping so a
				// permanent failure cannot spin.
				if (this.pending === null) this.pending = value;
				return;
			}
		}
	}
}
