<div align="center">

# EZNotepad

> A **5 MB** desktop utility: Markdown writing + text editing + file comparison.
> Portable, offline, ready to use on double-click.
> The UI supports 9 languages and follows the system language by default; switch manually under **Settings → Language**.

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português](README.pt.md)

[![Release](https://img.shields.io/github/v/release/EZLive00/EZNotepad)](https://github.com/EZLive00/EZNotepad/releases)
[![License](https://img.shields.io/badge/license-PolyForm--NC--1.0.0-orange)](./LICENSE)

</div>

---

## Download & Installation

Download from [Releases](https://github.com/EZLive00/EZNotepad/releases):

| Artifact | Best for |
|---|---|
| `EZNotepad_<version>_x64-setup.exe` | **Installer**: setup wizard + file associations — double-click a `.md` / `.txt` file to open it directly |
| `EZNotepad_<version>_x64-portable.zip` | **Portable**: extract anywhere and double-click `EZNotepad.exe` |

- Neither build is code-signed, so SmartScreen will block it once on first launch: click **More info** → **Run anyway**
- The portable build relies on the system WebView2 runtime (preinstalled on Win10 / Win11); it writes nothing to the registry and registers no file associations
- Windows x64 builds only, for now

---

## Screenshots

**Light theme**

![EZNotepad main window in light theme](docs/screenshots/light.png)

**Dark theme**

![EZNotepad main window in dark theme](docs/screenshots/dark.png)

---

## What It Replaces

| Used to use | Why | With EZNotepad |
|---|---|---|
| Notepad | Open any text file, change encoding, read logs | All of that, plus line numbers, highlighting, and an outline |
| Typora | Write Markdown with live rendering | Three modes to choose from, 20× lighter |
| BeyondCompare | Compare two files | Side-by-side with highlighting, character-level diff marks, F7/F8 to jump between differences |

---

## Three Modes (One Dropdown, Auto-Switched by File Type)

| Mode | What it does | Shortcut |
|---|---|---|
| **WYSIWYG** | Type `# ` for a heading, `**bold**` turns bold instantly | `Ctrl+1` |
| **Edit mode** | Raw Markdown / source with line numbers, syntax coloring, and code folding | `Ctrl+2` |
| **Preview mode** | Read-only rendering, built for reading | `Ctrl+3` |

**Supported file types**: `.md` (all three modes), `.json` (validation + highlighting + error location),
`.txt` `.log` `.csv`, and common code files (`.js/.ts/.py/.rs/.go/.html/.css/.sql/.yml/...`).
**New files ask you to pick a type first** (Markdown / Plain text / JSON / CSV / Code); non-Markdown files
only offer **Edit / Preview**, so they work as a plain text editor.

## Edit Mode Is Powered by CodeMirror 6

Not a `<textarea>` in disguise — a real code editor underneath:

| | Details |
|---|---|
| **Syntax coloring** | JS/TS/JSX, Python, Rust, Go, Java, C/C++, JSON, CSS, HTML, SQL, YAML, Shell, INI, Markdown — incremental parsing |
| **Line numbers / current line** | Line number gutter, current-line background, bracket matching, code folding |
| **Undo** | CM6's own transaction-level history — far more reliable than the browser's contenteditable |
| **Large files** | Only visible lines are rendered. In testing, 50k lines open in 49 ms, 100k lines in 20 ms, with only ~100 lines in the DOM |
| **Indentation** | `Tab` indents the selection or the current line; `Shift+Tab` outdents; Enter keeps the previous line's indent |
| **Bracket matching** | Typing `(` auto-inserts `)`, same for quotes; when the cursor sits inside a pair, typing the closing bracket skips over it instead of inserting another |
| **Themes** | Light and dark themes follow the app; syntax colors share the same set of CSS variables as the preview |

Colors are defined once in `styles.css` under `body[data-theme]` and consumed separately by the editor and
the preview renderer, so the two can never drift apart.

Unsupported options are grayed out automatically — with a JSON file open, **WYSIWYG** is disabled so you can't click it by mistake.

---

## Layout (Every Feature Has Exactly One Entry Point)

```
┌──────────────────────────────────────────────┐
│ ▣ File Edit Format View Tools Help  Welcome.md  － □ ✕│ ← Title bar (40px)
├──────────────────────────────────────────────┤
│ Welcome.md × │ test.json × │ +         Edit▾ ⌕ Save │ ← Tabs and toolbar share one row
├────────┬──────────────────┬──────────────────┤
│        │                  │                  │
│ Outline│  Edit / WYSIWYG  │     Preview      │
│        │                  │                  │
├────────┴──────────────────┴──────────────────┤
│ Ln 1,Col 1 │ 36 lines │ 243 chars │ Markdown │ LF │ UTF-8 │ Saved │
└──────────────────────────────────────────────┘
```

Above the content area there are only two rows: the title bar (menu + document title + window buttons), and
a single row combining tabs and tools (tabs on the left; on the right only the three high-frequency actions —
**mode switch / Find / Save**. Everything else lives in the menus and is never duplicated).
When the window gets narrow, the toolbar collapses to icons only.

The window has no system title bar (`decorations: false`): menu, document title, and window buttons all sit
on the top row; the empty space in between is draggable, and double-clicking it maximizes the window —
the same behavior as VS Code and WorkBuddy. The four corners use Win11's native DWM rounded corners,
and dragging the edges still resizes the window.
**View → Show Filename in Title Bar** hides the title text, leaving only the menu and buttons.

- **Outline** — navigation only
- **Sidebar** — two pages: Outline (highlights the current section as you scroll) / Files (directory tree + full-directory content search)
- **Toolbar** — only three high-frequency actions: mode, Find, Save; every other command goes through the menus
- **Editor area** — editing only
- **Status bar** — information only; encoding and line endings are clickable to change
- **Menus** — the complete command set
- **Settings** — one panel at `Ctrl+,`: theme, font size, UI, autosave, working folder
- **Compare Center** — a standalone full-screen panel, kept separate from the editor

---

### Sidebar "Files" Page: Directory Tree and Cross-File Search

- Lazy loading: each expanded level is read on demand, so opening a large repository doesn't load tens of thousands of files up front
- **Right-click to manage**: create files / folders in any directory, rename files, or delete them
  - Deletions go to the system **Recycle Bin**, so mistakes are recoverable; folders can only be deleted when empty — never recursively
  - Rename or delete keeps the already-open tab in sync (it never keeps pointing at the old path and writing back there)
- Search runs in Rust, skipping binary files and anything over 4 MB, returning at most 200 results
- The `.*` toggle on the search box enables regex; `Aa` toggles case sensitivity
- Results are grouped by file with line numbers and snippets; clicking one opens the file and jumps to that line
- **Cross-file replace**: enter the replacement in the box below the search field and click **Replace All**. It asks once first, since it writes to disk;
  a history snapshot is saved before each file is modified, so you can always recover
- Remembers the last opened folder; change or clear it in the Settings panel

---

### Find (`Ctrl+F` / `Ctrl+H`)

One overlay with two states: clicking the leftmost arrow expands it into two rows — **Find + Replace**; collapsed, it's Find only.
`Ctrl+F` only focuses the overlay (it never collapses an already-expanded replace row); `Ctrl+H` expands it directly.

| Capability | Details |
|---|---|
| **In-place Find in WYSIWYG** | No more switching to Edit mode just to search; highlights are painted on a rendering layer (CSS Highlight API), with no markup injected into the text |
| **Mode toggles** | Four small squares at the right of the input: `Aa` case-sensitive, `.*` regex, `Whole word`, `Selection`. Active toggles use the accent color |
| **Whole word** | Word boundaries are only added when both ends of the query are English word characters — Chinese has no word boundaries, and forcing `\b` would never match |
| **In selection** | Find/replace only within the selected text; grayed out when nothing is selected |
| **Newlines** | The `↵` button at the right end of the input (or `Ctrl+Enter`) inserts a newline and the box grows to fit; newline-free queries still never produce false matches across paragraphs |
| **Replace** | When the match is within the same run of text it's **replaced in place**, no dialog; only when it crosses a formatting boundary such as bold or a link does it ask to switch to Edit mode |
| **Cross-file** | The search box on the sidebar "Files" page, listing matching lines grouped by file |

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| New / Open / Save / Save As | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab / Switch tabs | `Ctrl+W` / `Ctrl+Tab` |
| Find / Replace / Go to Line | `Ctrl+F` / `Ctrl+H` / `Ctrl+G` |
| **Command palette** | `Ctrl+Shift+P` |
| Settings | `Ctrl+,` |
| **One-click format** | `Ctrl+Shift+F` |
| **Text compare** | `Ctrl+D` |
| Next / previous difference | `F8` / `F7` |
| Single pane ⇄ dual pane | `Ctrl+Shift+L` |
| Show / hide outline | `Ctrl+Shift+O` |
| Focus mode (`Esc` to exit) / Fullscreen | `F9` / `F11` |
| Bold / Italic | `Ctrl+B` / `Ctrl+I` |
| Strikethrough / Inline code | `Ctrl+Shift+X` / — |
| Insert link / Insert table | `Ctrl+K` / `Ctrl+Shift+T` |
| Body text / Headings 1–3 | `Ctrl+Alt+0` / `Ctrl+Alt+1~3` |
| Bullet / Numbered / Task list | `Ctrl+Shift+8` / `Ctrl+Shift+7` / `Ctrl+Shift+9` |
| Quote / Code block | `Ctrl+Shift+Q` / `Ctrl+Shift+K` |
| Indent / Outdent list | `Tab` / `Shift+Tab` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Export PDF | `Ctrl+P` |

---

## The Most-Used Features

### WYSIWYG: Genuinely Usable as an Editor

More than "type `# ` for a heading" — block-level structures are directly manipulable, and Markdown syntax stays consistent with WYSIWYG in both directions. Markers only need to be at the **start of a line**, not the end — write the text first, come back and add `## ` at the start of the line, and it still becomes a heading, with the text after the marker (including bold and links) preserved as-is:

| Capability | How |
|---|---|
| **Headings / body text** | Type `# `–`###### ` at the start of a line (adding it before existing text works too); `Ctrl+Alt+1~3` changes the level, press again to return to body text |
| **Bullet / Numbered / Task list** | Type `- ` / `1. ` / `- [ ] ` at the start of a line; `Tab` indents into a sub-item, `Shift+Tab` outdents a level |
| **Nested lists** | Up to 6 levels; switching between ordered and unordered keeps the hierarchy and renumbers automatically |
| **Quote** | Type `> ` at the start of a line; `Tab` increases the quote level, an empty line + Enter exits |
| **Code block / Horizontal rule** | Type ` ``` ` / `---` at the start of a line; inside a code block, Enter wraps lines and indents two spaces |
| **Tables** | `Ctrl+Shift+T` inserts a 3×3 table, or use **Format → Insert Table (custom size)** |
| **Table editing** | `Tab` / `Shift+Tab` moves between cells (a row is added automatically at the end), `Enter` moves to the same column on the next row, right-click adds/removes rows and columns and sets column alignment |
| **Inline styles** | Type `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](link)` and watch it render as you type |
| **Math** | Inline `$a^2+b^2=c^2$`, block-level `$$ … $$` (may span lines), typeset by KaTeX in the preview |
| **Table of contents** | **Insert → Table of Contents…** scans the headings and builds a clickable list; `Ctrl+click` an entry to jump to that section |
| **Insert image** | Paste a screenshot with `Ctrl+V`, drag an image file into the window, or use **Insert → Image…**: the image is copied to `assets/` next to the document and referenced with a relative path; you can also paste a web URL directly |
| **Image size** | In WYSIWYG, drag the image's bottom-right corner to change its width (the width is written into the alt suffix automatically); or write `![alt|300](a.png)` to cap width, `![alt|300x200](a.png)` to cap width and height; without a size, images display at original aspect ratio (max 320px tall) |
| **Backspace semantics** | Backspace at the start of a heading first reveals the `###` markers, then removes them one level at a time; at the start of a list item it first demotes the item, then turns it into a paragraph; at the start of a paragraph it merges the line into the previous one; `Delete` works the same in reverse |
| **Paste** | Multi-line text is parsed as Markdown into real headings/lists/tables instead of collapsing into one blob |

**Block handles at line start**: two small buttons — `+` and `⋮⋮` — float out to the left of the line with the cursor or mouse (they never cover text and can't be selected).
`⋮⋮` converts the block to a different type (body text / Heading 1–3 / list / quote / code block); `+` inserts a new block below.
They run the same commands as the top **Format** menu, just within reach.

The `###` markers on headings only appear when you actually change the level: backspace once at the start of the line reveals the markers (body text untouched), backspace again removes one `#`, and only when they're all gone does the line revert to body text — an accidental backspace never takes the level and the text down together. Moving the cursor away or pressing Enter hides the markers again.

Markers are recognized at "the short stretch just before the cursor," not the whole end of the line, so all three ways are equivalent: type `## ` then the heading, write the heading first and add `## ` at the start, or promote a plain paragraph to a heading. A stretch is only recognized when it consists of the marker itself (`## ` followed immediately by a space), so `#topic` inside body text is never mistaken for a heading, and typing `- ` with the cursor mid-line won't split a sentence into a list.

All block-level operations are also in the **Format menu** and the **context menu**, with inapplicable items grayed out automatically (e.g., all table commands are gray when the cursor isn't in a table).

### Math

- Inline `$a^2 + b^2 = c^2$`, block-level `$$ … $$` (may span lines, so matrices and multi-line derivations don't have to be crammed onto one line)
- Rendering happens only on the **preview side**: KaTeX is loaded lazily — only when an actual formula appears (~546 KB), so documents without math pay nothing
- In WYSIWYG, formulas are not rendered, only highlighted with a background — stuffing KaTeX's DOM into a contenteditable makes backspace fail and the cursor stick, a cost far outweighing the benefit. Press `Ctrl+3` to preview, or enable dual-pane so the preview sits alongside
- Formula segments are protected **before** emphasis syntax is parsed, so the `_` and `*` in `$x_1 * y$` remain a subscript and a multiplication sign rather than becoming italics

### Focus Mode (`F9`, `Esc` to Exit)

Tabs, sidebar, status bar, and menus all fold away, leaving only the text. The title bar fades to near-invisible and returns when the mouse moves over it — since the window is borderless, losing the title bar too would mean no dragging, no minimize, no close, effectively locking you inside your own document.

### Double-Click to Open / Single Instance

Once the installer finishes, `.md` `.markdown` `.txt` `.log` `.json` `.csv` are all registered as file associations;
right-click → **Open with** in Explorer and you'll find **EZNotepad**.

Only one window per program: double-clicking another file never spawns a second process —
the path is handed to the already-running window to open (and it's restored from the minimized state along the way).
Two windows editing the same file and overwriting each other is impossible by design.

> Only the **installer** registers file associations. The portable build and a bare exe from `cargo build` write nothing to the registry.

### File Change Watching

Open documents are watched in real time (the backend uses the system's `ReadDirectoryChangesW` / `inotify`, listening only to the file's own directory level and only to whitelisted filenames). When another program modifies a file:

- File in the **current tab**: silently reloads with a notice if you have no local changes; asks first if there are unsaved changes
- File in a **background tab**: no popup interruption — an amber dot appears on the tab, and it asks when you switch to it

Saving your own work never triggers it (the modification time is already synced after save). Can be disabled entirely in Settings.

### One-Click Format (Smart per File Type)

| Type | What it does |
|---|---|
| **JSON** | Validate + re-indent; auto-fixes fullwidth quotes, trailing commas, and comments; **on a syntax error, the file is left untouched and a "line X, column Y" error is shown** |
| **Markdown** | Blank lines around headings, unified list markers, trailing whitespace removed, blank lines collapsed |
| **TXT / logs / code** | Line endings normalized, trailing whitespace removed, consecutive blank lines collapsed |

After formatting, one **Undo** restores the original.

### Version History (File → Version History…)

Every save snapshots the content **before** saving, stored in the local app data directory (nothing gets dumped into your documents folder).
After one-click format, sort/dedupe, or bulk replace, `Ctrl+Z` may not get you back — this is the last line of defense.

- Up to 60 snapshots per file, 20 MB total; the oldest are cleared first when exceeded
- **View** opens that version as a read-only new tab; **Restore** writes it back into the editor — **neither touches disk until you press `Ctrl+S` yourself**
- Same principle as text compare and three-way merge: rollback never overwrites the original file directly

### Export Web Page (File → Export Web Page…)

Saves the current document as a **single-file HTML**: styles inlined and images converted to data URIs.
Send it to someone or drop it into a static site and it opens as-is — no broken images.
Images over 4 MB are not embedded (their original paths are kept); the export notice reports how many were embedded.

### Command Palette (`Ctrl+Shift+P`)

The hundred-plus commands in the menus are a few keystrokes away: type `focus`, `format`, or `replace`,
pick with `↑` `↓`, run with `Enter`, close with `Esc`. The list is generated directly from the menu tree, so new menu commands appear here automatically.
Commands unavailable in the current state are grayed out, and clicking one tells you why.

### Remap Shortcuts Yourself (Settings → Shortcuts)

The Settings panel lists every command that has a shortcut. Click **Change** and press the new combination (must include `Ctrl` / `Alt`,
or be a single `F1`–`F12` key); `Esc` cancels. Custom bindings take priority over defaults; if you break something, **Reset** brings it back,
and **Restore Defaults** clears them all.

### Text Compare (`Ctrl+D`)

- Side by side with **line-level + character-level** highlighting (only the few characters that actually changed are marked)
- Ignore whitespace / ignore case
- `F7` / `F8` jump between differences
- Each difference block has a **→** button to sync that block from left to right in one click
- One-click export of an HTML comparison report

### Folder Compare

Recursively compares two directories, listing **Left only / Right only / Modified / Identical**; click a row to jump straight into a text compare of that file.

### Three-Way Merge (Tools → Three-Way Merge)

Pick a **base version + side A + side B**; both sides' changes are merged automatically and conflicts are listed.
**The result opens only in a new tab — it never overwrites any original file.**

### Encoding and Line Endings

Click `UTF-8` in the bottom-right of the status bar to save with a different encoding (UTF-8 / GBK / UTF-16, BOM optional);
click `LF` to switch to CRLF. Old GBK-encoded txt files open without garbled text.

---

## Benchmarks

Measured locally (Windows 11, x64, release build):

| Scenario | Metric |
|---|---|
| Everyday typing (600-paragraph document, WYSIWYG) | Average **9.1 ms** per keystroke |
| Huge document open (10.8 MB / 77,866 blocks) | **1.14 s**, UI never freezes (viewport rendering, ~48 blocks kept in the DOM) |
| Huge document typing | p50 latency **0.3 ms** |
| Huge document scrolling | ~**17 ms** per frame, full frame rate |
| Huge document undo | **37 ms** per step, byte-identical round-trip |
| Large plain-text files (CodeMirror 6) | 50k lines open in **49 ms**, 100k lines in **20 ms**, only visible lines rendered |
| Memory usage | ~**170 MB** on a clean start (including the WebView2 GPU process) |
| Size | Installer **2.63 MB** |

---

## Data & Privacy

- All files are read and written only on your machine — **no network access, no uploads**
- Drafts are saved in the local app data directory and survive closing the window: **all** unsaved tabs are stored,
  and on next startup you're asked whether to restore them (not just the last one)
- History snapshots live in `history/` under that same directory, fully separate from your documents folder
- On first launch, if unsaved drafts are detected, you're asked whether to restore them

---

## Known Limitations

- PDF export goes through the system print dialog ("Save as PDF"); layout follows the print output
- Three-way merge is semi-automatic: auto-merge + conflict list, no four-pane visual merger (for complex conflicts, work through them block by block with Text Compare)
- Platform-specific installers must be built on the corresponding OS (see `构建说明.md`)
- Cross-file search defaults to literal, case-insensitive matching; regex is available; capped at 200 results
- Cross-file replace only handles **UTF-8** files: GBK and similar encodings are skipped as-is rather than silently re-encoding the whole file
- Deletions in the file tree go to the system Recycle Bin; **folders can only be deleted when empty** — never recursively
- The file **tree** itself isn't watched: files created/deleted elsewhere require right-click → **Refresh** in an empty area, or re-expanding the directory (open documents are watched in real time — see above)
- Math is rendered only on the preview side and shows as source in WYSIWYG; Mermaid diagrams are not yet supported

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE):

- **Noncommercial use** (personal use, learning, research, non-profit organizations, etc.): free to use, modify, and distribute
- **Commercial use**: requires prior permission from the project team — just [open an Issue describing your use case](https://github.com/EZLive00/EZNotepad/issues)
- The source is public but commercial licensing is reserved — a deliberate choice; this license notice must accompany any distribution
