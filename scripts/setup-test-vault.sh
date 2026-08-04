#!/usr/bin/env bash
#
# Builds `test-vault/` - a throwaway Obsidian vault for exercising the plugin by
# hand. The vault itself is gitignored; this script is what makes it
# reproducible, so run it instead of hand-rolling a vault.
#
# Existing files are left alone, so it is safe to re-run over a vault you have
# already been typing in.
#
# Usage: npm run test-vault
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vault="$root/test-vault"

mkdir -p "$vault/.obsidian/plugins" "$vault/Journal" "$vault/Templates"

# The plugin folder is a link to the repository, so the vault always loads
# whatever `npm run build` last produced - there is nothing to copy after a
# rebuild.
ln -sfn ../../.. "$vault/.obsidian/plugins/journal-view"

write() { # write <relative path> - from stdin, only when the file is missing
	local path="$vault/$1"
	if [ -e "$path" ]; then
		echo "  kept    $1"
		cat >/dev/null
	else
		cat >"$path"
		echo "  created $1"
	fi
}

write .obsidian/core-plugins.json <<'JSON'
{
	"file-explorer": true,
	"global-search": true,
	"switcher": true,
	"daily-notes": true,
	"templates": true,
	"command-palette": true,
	"editor-status": true,
	"properties": true,
	"file-recovery": true
}
JSON

write .obsidian/community-plugins.json <<'JSON'
[
	"journal-view"
]
JSON

write .obsidian/daily-notes.json <<'JSON'
{
	"folder": "Journal",
	"format": "YYYY-MM-DD",
	"template": "Templates/Daily",
	"autorun": false
}
JSON

write .obsidian/app.json <<'JSON'
{
	"promptDelete": false,
	"alwaysUpdateLinks": true
}
JSON

# Frontmatter plus a body, so both halves of a created note can be checked.
write Templates/Daily.md <<'MARKDOWN'
---
type: daily
date: {{date:YYYY-MM-DD}}
weekday: {{date:dddd}}
mood:
tags:
  - journal
---

## Log

-

## Notes
MARKDOWN

# A note that already exists, to check that days with content are left alone.
write Journal/2026-08-02.md <<'MARKDOWN'
---
type: daily
date: 2026-08-02
weekday: Sunday
mood: steady
tags:
  - journal
---

## Log

- An existing note. Days that have one must never be offered a template.

## Notes
MARKDOWN

write Journal/2026-07-30.md <<'MARKDOWN'
---
type: daily
date: 2026-07-30
weekday: Thursday
mood: quiet
tags:
  - journal
---

## Log

- An older note, with empty days between it and the notes after it.

## Notes
MARKDOWN

write README-TESTING.md <<'MARKDOWN'
# Journal View test vault

Throwaway vault for exercising the plugin by hand. Gitignored, so anything written
here stays local. Rebuild it any time with `npm run test-vault` from the repository
root; files that already exist are kept.

`.obsidian/plugins/journal-view` links to the repository root, so the vault loads
whatever `npm run build` last produced.

Daily notes resolve to folder `Journal`, format `YYYY-MM-DD`, template
`Templates/Daily`. Journal View's own overrides are left empty, so those vault
settings are what it inherits.

## Opening it

Obsidian has to know the vault before the URL scheme will open it. The first time,
add it through the vault switcher (bottom left) -> Manage vaults -> Open folder as
vault, and pick `test-vault`. After that:

```bash
open "obsidian://open?vault=test-vault"
```

## Driving it from the terminal

The `obsidian` CLI reaches the vault by name, which beats clicking for anything
repeatable:

```bash
obsidian vault=test-vault command id=journal-view:open
```

`eval` runs JavaScript inside the vault's window, so a day can be inspected
directly:

```bash
obsidian vault=test-vault eval code='const v=app.workspace.getLeavesOfType("journal-view")[0].view; const s=v.sections.find(x=>x.offset===0); s.editor.focus(); s.editor.getValue()'
```

Two things will waste your afternoon if you do not know them:

- **Obsidian must believe it has focus.** Chromium does not dispatch focus events
  while `document.hasFocus()` is false, so anything driven from the terminal with
  the window in the background silently skips every focus path - which reads
  exactly like the feature being broken. Turn focus emulation on first, and off
  when you are done:

  ```bash
  obsidian vault=test-vault dev:debug on && obsidian vault=test-vault dev:cdp method=Emulation.setFocusEmulationEnabled params='{"enabled":true}'
  ```

- **Plugins are not hot-reloaded.** After `npm run build` the running window still
  has the old code:

  ```bash
  obsidian vault=test-vault eval code='(async()=>{await app.plugins.disablePlugin("journal-view"); await app.plugins.enablePlugin("journal-view"); return "reloaded"})()'
  ```

Useful while debugging: `dev:errors` (unhandled rejections land here), `dev:console`,
`dev:dom selector=...`, and `dev:cdp method=Input.insertText params='{"text":"..."}'`
to type into whatever holds focus.

## Checks worth running

1. **Type in an empty day.** The day fills with the template body on focus; type,
   then read the note. It should have the template's frontmatter with `date` and
   `weekday` filled in for that day, above what you typed.
2. **Enter an empty day and leave without typing.** The template appears, then goes
   away on blur, and no file is created under `Journal/`.
3. **"Create note" button.** Same note as (1).
4. **A day that already has a note.** No template offered; content untouched.
5. **A template that cannot be read.** Point `daily-notes.json` at a missing file:
   the day stays empty, a warning is logged, and `dev:errors` stays clean.

## Resetting

```bash
git clean -xfd test-vault   # or just delete the notes the checks created
npm run test-vault
```
MARKDOWN

echo
echo "test-vault ready at $vault"
echo "Add it in Obsidian once (Manage vaults -> Open folder as vault), then see test-vault/README-TESTING.md"
