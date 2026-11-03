<div align="center">

# EZNotepad

> A **5 MB** desktop utility: Markdown writing, text editing and file comparison.
> Portable, offline, ready on double-click.
> The UI speaks 9 languages and follows the system language; switch it under **Settings → Language**.

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-AGPL--v3-blue)](./LICENSE)

</div>

---

## Download

| Artifact | Best for |
|---|---|
| `EZNotepad_<version>_x64-setup.exe` | **Installer** — setup wizard plus file associations, so a double-click on a `.md` / `.txt` opens here |
| `EZNotepad_<version>_x64-portable.zip` | **Portable** — unzip anywhere and run `EZNotepad.exe` (no registry, no associations) |

Releases are unsigned: SmartScreen blocks the first launch once — click **More info → Run anyway**.
Windows x64 only for now; the portable build uses the system WebView2 runtime (preinstalled on Windows 10 / 11).

## Screenshots

| Light | Dark |
|---|---|
| ![Main window, light theme](docs/screenshots/light.png) | ![Main window, dark theme](docs/screenshots/dark.png) |

| Write on the left, preview on the right | Compare: line and character marks |
|---|---|
| ![Dual pane](docs/screenshots/split.png) | ![Text compare window](docs/screenshots/compare.png) |

## What It Replaces

| Instead of | Because | Here |
|---|---|---|
| Notepad | Any text file, encoding switch, log reading | The same, plus line numbers, highlighting and an outline |
| Typora | Markdown with live rendering | Three modes, 20× lighter |
| BeyondCompare | Comparing two files | Side by side, character-level marks, `F7` / `F8` to walk the differences |

## Three Modes

| Mode | What it does | Shortcut |
|---|---|---|
| **WYSIWYG** | Type `# ` for a heading, `**bold**` turns bold as you type | `Ctrl+1` |
| **Edit** | Raw Markdown / source, CodeMirror 6 with line numbers and folding | `Ctrl+2` |
| **Preview** | Read-only rendering, built for reading | `Ctrl+3` |

`.md` supports all three. `.json` gets validation plus error location; `.txt` `.log` `.csv` and code files
(`.js .ts .py .rs .go .html .css .sql .yml` …) get Edit / Preview only, so they behave like a plain text editor.
New files ask for a type first (Markdown / Plain text / JSON / CSV / Code).

## Editing

| | |
|---|---|
| **Blocks** | `# ` heading, `- ` / `1. ` / `- [ ] ` list (6 levels), `> ` quote, ` ``` ` code, `---` rule — markers only need to sit at the start of a line |
| **Inline** | `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](link)` render while you type |
| **Undo / redo** | The two arrows at the far left of the toolbar (grey at the ends), `Ctrl+Z` / `Ctrl+Y`; `Ctrl+Shift+Z` redoes too — WYSIWYG and plain text each keep their own history stack |
| **Tables** | `Ctrl+Shift+T` inserts one; `Tab` walks cells, `Enter` goes to the same column below, right-click adds or removes rows and columns |
| **Images** | Paste a screenshot, drag a file in, or **Insert → Image**: the file is copied to `assets/` next to the document. Drag the bottom-right corner to resize, or write `![alt\|300](a.png)` |
| **Math** | `$a^2+b^2=c^2$` inline, `$$ … $$` as a block, typeset by KaTeX in the preview (loaded only when a formula appears) |
| **Callouts** | `> [!info]` / `warning` / `danger` / `success`, with GitHub aliases accepted |
| **Block handles** | `+` and `⋮⋮` float out at the line start: insert a block, or convert this one to another type |
| **Paste** | Multi-line text is parsed into real headings, lists and tables instead of one blob |

Block type conversions (`Ctrl+Shift+Q` quote, `Ctrl+Shift+K` code…), the **Format** menu, the context menu and
`Ctrl+Shift+P` (command palette) all run the same command set, and inapplicable items gray out on their own.

### Find and Replace

One overlay, two states: `Ctrl+F` focuses it, `Ctrl+H` expands replace. Search works **inside WYSIWYG** without
switching modes — highlights are painted, never injected into the text.

`Aa` case-sensitive · `.*` regex · whole word (only added when both ends are English word characters, since Chinese
has none) · selection only · `↵` inserts a newline in the query. A match inside one run of text is replaced in place;
only a match crossing bold or a link asks to switch to Edit mode.

## Quick Note

`Ctrl+Shift+M` (or the **Quick Note** item in the menu bar) opens one fixed scratch file:

- **No saving** — edits reach the disk about 0.35s after you stop typing, and are flushed before a tab or the window closes; no unsaved dot, no "save?" prompt
- **Fixed location** — `<app data dir>/quicknote.md`; **File → Quick Note** shows where it lives and can reveal it in Explorer
- **Pick up where you left off** — the caret lands at the end; **Insert Current Time** adds `2026-11-03 09:20`
- **Clearing is reversible** — **Clear Quick Note** keeps a copy in Version History first

It is still an ordinary Markdown tab (modes, export, search) — it just stays out of Recent and out of the restored session.

## Compare

`Ctrl+D` (or `Ctrl+Shift+N`) opens the compare window with **two blank editable panes** and the caret already on the left — just `Ctrl+V`:

- **Two files** — click the folder icon left of a file name at the top; or select them with `Ctrl` / `Shift` in the sidebar Files page, then right-click → **Compare These Two Files** (the one you right-clicked stays on the left)
- **Two texts** — paste one into each side; no file needed
- **Edit both sides** — both panes are writable from the start; **Save** writes back only where there is a real file

Line-level marks show what changed, character-level marks show which characters. `F7` / `F8` walk the differences, and **Export Report** writes a standalone HTML diff.
The ruler on the right maps the whole file — hover for line numbers, click or drag to jump; **Differences**
turns every change into a sortable, filterable list (position, type or size).
**Sort** reorders both sides alphabetically (blank lines stay at the end), so ordering noise stops drowning the real additions and deletions; `Ctrl+Z` undoes it.
In edit mode `Ctrl+Z` / `Ctrl+Y` undo and redo typing, line breaks, indentation, selection deletes and sorting — even when the focus sits on the toolbar.
The toolbar carries the same two buttons, greyed out at the ends of the stack; when the window narrows the row folds into icons instead of clipping a button.
**Differences only** is on by default: identical lines are folded away, keeping three lines of context around every change — 2,000 lines with 20 edits collapse to a few dozen. To edit an identical line further away, untick the box in the toolbar.
`Ctrl+F` searches both panes at once; matching lines are tinted, and `Enter` / `Shift+Enter` step through them.

A single side is capped at 8 MB / 50,000 lines; past that the window says why instead of failing quietly.

**Compare Folders** opens its own window: each side lists its own files and one row is one pair, so *left only / right only / modified* reads at a glance. Click a pair to diff it, or a one-sided file to open it in the main window. **Three-way Merge** takes base + A + B, auto-merges and lists conflicts — the result opens in a
new tab and never overwrites an original.

## Files and Search

The sidebar has two pages: **Outline** (highlights the section you are reading) and **Files**.

- Lazy directory tree; right-click to create, rename or delete — deletions go to the **Recycle Bin**, and folders can only be deleted when empty
- Searching runs in Rust, skips binaries and files over 4 MB, returns at most 200 hits grouped by file with line numbers
- `.*` toggles regex, `Aa` toggles case sensitivity
- Open documents are watched in real time (`ReadDirectoryChangesW`): the current tab reloads silently, a background tab gets an amber dot and asks when you switch to it

## Everything Else

| | |
|---|---|
| **Many tabs** | Drag to reorder, middle-click to close; the wheel scrolls the strip sideways, and dragging a tab to an edge keeps it scrolling — once they stop fitting, an "All tabs" menu appears on the right |
| **One-click format** | `Ctrl+Alt+L` — JSON validate + reindent (leaves the file untouched and reports line / column on error), Markdown blank lines and list markers, trailing whitespace for everything. One `Ctrl+Z` undoes it |
| **History** | Every save snapshots the previous content (60 per file, 20 MB total). **View** opens it read-only, **Restore** writes it back to the editor — disk changes only when you press `Ctrl+S` |
| **Export** | Single-file HTML with inlined styles and data-URI images; PDF through the system print dialog |
| **Shortcuts** | Settings → Shortcuts remaps anything; custom bindings win, **Reset** puts one back, **Restore Defaults** clears all |
| **Focus mode** | `F9` folds away tabs, sidebar, status bar and menus; the title bar fades to 28% instead of disappearing, so you can still drag and close the window |
| **Single instance** | Double-clicking another file hands the path to the running window instead of starting a second process |
| **Encoding** | Click `UTF-8` or `LF` in the status bar to change encoding (GBK / UTF-16 / BOM) or line endings |

## Shortcuts

| Action | Keys |
|---|---|
| New / Open / Save / Save As | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab / Next tab | `Ctrl+W` / `Ctrl+Tab` |
| Open quick note | `Ctrl+Shift+M` |
| Find / Replace / Go to line | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| Command palette / Settings | `Ctrl+Shift+P` / `Ctrl+,` |
| Format / Compare | `Ctrl+Alt+L` / `Ctrl+D` |
| Next / previous difference | `F8` / `F7` |
| Copy this difference to the other side (add `Ctrl` to keep going) | `Alt+←` / `Alt+→` |
| Find in both panes (compare window) | `Ctrl+F` |
| Single ⇄ dual pane / Outline | `Ctrl+Shift+L` / `Ctrl+Shift+O` |
| Focus mode / Fullscreen | `F9` / `F11` |
| Bold / Italic / Strike / Code | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` / `Ctrl+Shift+K` |
| Link / Table / Quote | `Ctrl+K` / `Ctrl+Shift+T` / `Ctrl+Shift+Q` |
| Body / H1–H3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Bullet / Numbered / Task list | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Indent / outdent list | `Tab` / `Shift+Tab` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Export PDF | `Ctrl+P` |

## Benchmarks

Measured locally (Windows 11, x64, release build):

| Scenario | Metric |
|---|---|
| Typing in a 600-paragraph document | **9.1 ms** per keystroke |
| Opening 10.8 MB / 77,866 blocks | **1.14 s**, ~48 blocks in the DOM, no freeze |
| Typing / scrolling / undo in that document | p50 **0.3 ms** / ~**17 ms** per frame / **37 ms** per step |
| CodeMirror 6, plain text | 50k lines in **49 ms**, 100k lines in **20 ms** |
| Memory / installer | ~**170 MB** on a clean start / **2.63 MB** |

Huge Markdown files use viewport rendering: only the visible blocks exist in the DOM, everything else is a record.
Undo snapshots are record arrays, so a keystroke never copies the whole document.

## Data

Everything stays on this machine — **no network, no upload, no telemetry**. Drafts of all unsaved tabs live in the
local app data directory and are offered back on the next start; history snapshots sit in `history/` under the same
folder, separate from your documents.

## Known Limitations

- PDF goes through the system print dialog, so the layout follows print output
- Three-way merge auto-merges and lists conflicts; there is no four-pane visual merger (use Text Compare block by block)
- Math renders in preview only and shows as source in WYSIWYG; Mermaid is not supported
- The file tree is not watched; **Refresh** from the context menu after changes made elsewhere
- Installers must be built on their own OS (see `docs/构建说明.md`); architecture and porting notes live in `docs/`

## License

[GNU Affero General Public License v3.0](LICENSE) — free to use, study, modify and redistribute. Derivative works,
including a hosted service built on top of it, must be released under AGPL-3.0 as well.
