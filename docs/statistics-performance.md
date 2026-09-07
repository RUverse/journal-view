# Statistics verification

Measured on September 7, 2026 using Obsidian 1.13.7 and its official CLI on a
Raspberry Pi 5 Model B (ARM64 Linux). All fixtures were in the gitignored
`test-vault`; no personal vault was used.

## Year loading

The vault contained 57,309 Markdown files: 50,000 unrelated notes, twenty years
of daily notes, and the original test fixtures. Daily-note bodies generally
contained 100, 500, 1,000, or 2,100 words. Measurements started after Obsidian
finished initializing the vault, with journal editor panes closed.

The CLI instrumented `vault.cachedRead`, `vault.getMarkdownFiles`, a 16 ms
heartbeat, and the Statistics view's loading state. “Uncached” means that the
plugin's count cache was empty, not that operating-system or Obsidian read
caches were empty. These are individual observations, not latency guarantees.

| Operation | Grid construction and lookups | Counts available | Content reads | Vault scans |
| --- | ---: | ---: | ---: | ---: |
| Uncached leap year, 2020 | 26 ms | 1,476 ms | 366 | 0 |
| Same year, cached | 37 ms | 37 ms | 0 | 0 |

No unrelated files were read. At most two reads were in flight. During the
uncached load, the heartbeat ran 82 times with a largest interval of 93 ms.
After visiting six additional full years, the cache contained exactly its
2,000-entry limit. The cache stores counts and file metadata, not note text;
Obsidian manages its own read cache separately.

A separate 10,000,000-byte daily note containing 2,000,000 words counted
correctly in 2,438 ms. The heartbeat ran 147 times with a maximum interval of
74 ms. Switching away during a second count took 54 ms; the abandoned result
was not cached. The Vault API still reads a whole file into memory, so this
does not establish a fixed memory bound for arbitrarily large individual notes.

## Startup limitation

Opening the bulk fixture with the plugin already enabled stalled before CLI
evaluation became available. This also reproduced with an independently built,
unmodified `origin/dev` at `d1fe86d`: it remained unresponsive for over a minute
before the comparison was interrupted. Opening the same vault with community
plugins disabled succeeded; enabling Journal View afterwards allowed the
measurements above. The precise startup bottleneck was not profiled. Statistics
does not resolve this existing startup limitation, and its measured year-loading
times must not be interpreted as whole-vault startup times.

A later startup also stalled with community plugins disabled after the bulk
fixtures were removed. This points to an application/environment or cache issue;
the observation does not establish a fault in Journal View's index.
Moving aside the new test installation's IndexedDB cache restored successful
startup with the feature enabled and the reduced fixture. The full bulk-vault
startup was not repeated after that cache reset.

The bulk fixtures were removed after measurement, retaining one full example
year and the count-boundary fixtures for ordinary UI testing.

## Correctness and lifecycle

Exercised through the running Obsidian application:

- Native journal **More options** menu contains Statistics.
- Normal and leap years have 365 and 366 tiles, including February 29.
- Exact counts and color levels at 0, 1, 299, 300, 799, 800, 1,999, and 2,000
  words; YAML properties excluded.
- Saved edits update counts. Renaming a note moves its tile; deletion clears it.
- One daily-note edit causes one Statistics content read. An unrelated edit
  causes no Statistics reads. Obsidian's own metadata reads are separate.
- Rapid year switching starts at most two reads from the abandoned year and
  does not paint its results into the selected year.
- A deliberately failed read displays an error tile; a retry succeeds after
  restoring the reader.
- A modification arriving during a delayed read cannot cache the old count.
- Custom daily-note folder and nested date format resolve correctly. Renaming
  a year folder updates both years.
- Timeline filters do not change Statistics. Opening a selected filtered-out
  entry reveals that date in the journal.
- Keyboard focus and arrow navigation update the selected day and details.
- Closing during two delayed reads leaves zero running jobs, queued jobs, and
  view listeners once those reads finish.
- Light and dark appearances and a narrow desktop pane inspected visually.
  Actual mobile-device behavior was not tested.

`npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`
passed. Runtime checks ended without captured application errors; the failed
read check deliberately produced a warning.

The generated `test-vault/README-TESTING.md` contains the repeatable interaction
checklist. Performance fixture generation and CLI instrumentation were temporary
local scripts, not additions to the plugin or an automated test suite.
