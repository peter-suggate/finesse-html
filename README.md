# Finesse

Click any block-level element in an HTML file. Edit the text. Source updates with byte-perfect preservation of everything you didn't touch.

A VS Code / Cursor extension that turns static HTML files into a click-to-edit surface. Hover a `<p>`, `<h1>`, `<li>`, `<td>` — see an outline. Click it — type. Blur or press Enter — the source file is updated through VS Code's normal text-edit pipeline (so undo/redo, dirty-state, and `Cmd+S` all work as you'd expect). Comments, indentation, attribute quoting, and unrelated whitespace survive verbatim.

**Status:** v0.0.1 — Phase 1 implementation + Phase 2 polish complete. Sideload-only. Not yet on the marketplace.

---

## Quickstart

### Install

The packaged `.vsix` is built locally; install it into Cursor or VS Code:

```bash
# Cursor
cursor --install-extension /Users/petersuggate/code/anjuna/finesse-html/finesse-html.vsix

# VS Code
code --install-extension /Users/petersuggate/code/anjuna/finesse-html/finesse-html.vsix
```

Or via the UI: Extensions panel → `⋯` (More Actions) → **Install from VSIX…** → choose the file. Reload the window.

### Use

1. Open a workspace folder.
2. Open an HTML file in an editor pane.
3. `Cmd+Shift+P` → **Finesse: Open Preview**. The preview opens beside.
4. Hover an element — blue outline.
5. Click — solid outline, block becomes editable, cursor lands at the end.
6. Type. Then:
   - **Enter** or **click outside** — commit. The source file becomes dirty in VS Code; `Cmd+S` saves it.
   - **Escape** — revert and exit.

You can also tab between editable blocks (`Tab` / `Shift+Tab`) and press `Enter` to begin editing the focused block.

---

## What it edits

- **Text content** of block-level elements: `p`, `h1`–`h6`, `div`, `section`, `article`, `aside`, `header`, `footer`, `nav`, `main`, `li`, `dt`, `dd`, `figcaption`, `blockquote`, `address`, `td`, `th`, `caption`.
- Inline tags inside an editable block (`<strong>`, `<em>`, `<code>`, `<a>`, `<kbd>`) are preserved across edits — type freely across them.

## What it won't edit (v1)

- **Attributes** (`href`, `src`, `alt`, `class`, `title`). → planned for v0.2 (Phase 3B).
- **Structure** — adding/removing/reordering elements, inserting new paragraphs. Press `Enter` while editing commits the edit; it does *not* insert a new paragraph.
- **`<pre>` and `<code>` content** — locked. Whitespace edits in those would be too easy to get wrong; v2 may add a code-mode editor.
- **Templated files** — anything containing `{{…}}`, `<%…%>`, `${…}`, `<?…?>`, or `{%…%}` shows a preview-only banner. Click **Edit anyway** in the banner to inject `data-finesse-allow="true"` on `<html>` and unlock; template-bearing text nodes stay individually locked.

## Per-element opt-out

Add `data-no-edit` to any element (or `contenteditable="false"`) and Finesse ignores it.

```html
<p data-no-edit>This paragraph is read-only in the preview.</p>
```

---

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `finesse.port` | `"auto"` | Preview HTTP server port. `"auto"` allocates ephemeral. Pin a number if you want a stable URL. |
| `finesse.templateTokens` | five default regexes | Patterns that mark a file as templated. Override to extend or restrict. |
| `finesse.serverIdleTimeout` | `60000` ms | Time after the last preview closes before the HTTP server shuts down. |
| `finesse.reloadDebounceMs` | `150` ms | Debounce window for external-file-change reloads. |
| `finesse.openOnHtmlOpen` | `false` | Auto-open the preview whenever an HTML file opens. |
| `finesse.editableElements` | `[]` | Reserved for v2: override the block-container tag list. |
| `finesse.aiCommand` | `""` | Reserved for v2 (Phase 3A): command id to invoke for "Rewrite with AI". |

---

## How it works

```
┌────────────────────┐         postMessage         ┌────────────────────────┐
│  Extension host    │ ◄───────────────────────►  │  Webview panel         │
│  - parse5 walker   │                             │  - status bar          │
│  - applyEdit       │                             │  - banners             │
│  - HTTP server     │                             │  - iframe host         │
└─────────┬──────────┘                             └─────────┬──────────────┘
          │                                                  │ postMessage
          │   http://127.0.0.1:PORT/path/to/file.html        ▼
          └──────────────────────────────────────►  ┌────────────────────────┐
                                                    │  Iframe                │
                                                    │  - real DOM            │
                                                    │  - hover/select        │
                                                    │  - contentEditable     │
                                                    └────────────────────────┘
```

- **parse5** parses the HTML with `sourceCodeLocationInfo` so every editable text node carries its `(startOffset, endOffset)` byte range.
- A local **HTTP server** on `127.0.0.1` serves the workspace and injects an instrumentation script + offset map into HTML responses.
- An **iframe** in the webview renders the file and instruments hover/click/edit.
- On commit, the iframe diffs the post-edit text nodes against a snapshot taken at focus; the host applies one `WorkspaceEdit` per session, splicing only the `[start, end)` ranges that changed (right-to-left so subsequent offsets stay valid). Bytes outside the edited spans are never touched.

Full design: [SPEC.md](./SPEC.md).

---

## Development

```bash
git clone <this repo>
cd finesse-html
npm install
npm run build      # produces dist/{host,iframe,webview}/*
npm run typecheck  # tsc across host, iframe, webview targets
npm run lint
npm run package    # builds finesse-html.vsix
```

### Run the Extension Development Host

Open the repo in VS Code or Cursor and press **F5**. A second window opens with `fixtures/` loaded as the workspace, the extension under development running. Pick a fixture, run **Finesse: Open Preview**, edit.

### Headless smoke test

```bash
npx esbuild scripts/smoke.ts --bundle --platform=node --format=cjs --outfile=dist/smoke.js
node dist/smoke.js
```

This bundles `walkEditable` + `detectTemplate` and runs them against every `fixtures/*.html`, asserting:
- editability rules (locked tags don't expose text nodes),
- template detection,
- byte-perfect splice for representative edits.

The output is a 7/7 pass.

### Repository layout

```
src/
├── shared/protocol.ts        # locked message contract (don't edit lightly)
├── host/                     # extension host (Node)
│   ├── extension.ts          # activation, command registration
│   ├── commands.ts           # openPreview, closePreview, editAnyway
│   ├── panel.ts              # WebviewPanel lifecycle, embedded webview HTML, message routing
│   ├── applyEdit.ts          # right-to-left splice with version validation
│   ├── documentWatcher.ts    # self-vs-external edit discrimination
│   ├── fileWatcher.ts        # debounced FileSystemWatcher for HTML/CSS/JS
│   ├── config.ts             # typed settings reader
│   ├── parse/                # parse5 walker + template detection
│   └── server/               # local HTTP server + WebSocket reload
├── iframe/                   # iframe runtime (browser, IIFE)
│   ├── main.ts               # entry; postMessage protocol
│   ├── overlay.ts            # hover + selection rectangles
│   ├── editSession.ts        # contentEditable lifecycle, snapshot/diff
│   └── pasteSanitizer.ts     # force text/plain on paste
└── webview/                  # webview shell (browser, IIFE)
    ├── main.ts               # iframe host + cross-origin relay
    ├── banners.ts            # template/error/stale-reload notifications
    └── status.ts             # status bar
fixtures/                     # contract test corpus
scripts/smoke.ts              # headless round-trip test
SPEC.md                       # full design document
```

---

## Roadmap

**v0.2 (Phase 3)**
- Cursor Cmd-K passthrough — right-click a block in the preview, "Rewrite with AI" sends the source range to Cursor's inline edit.
- Attribute editing — small property panel for `href`, `src`, `alt`, `class`, `title`.
- Publish to VS Code Marketplace and Open VSX.

**v0.3+**
- Code-mode editing for `<pre>`/`<code>`.
- Structural edits (insert paragraph on Enter, delete on Backspace-empty, reorder via drag).
- Template-aware parsers (Handlebars, EJS, Liquid) so `{{…}}` regions stay protected while text around them edits.

---

## License

MIT
