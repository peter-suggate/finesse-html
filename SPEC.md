# Finesse — Specification

A VS Code / Cursor extension that turns HTML files into a precise editing surface: open an HTML file → see it rendered in a side panel → click any block-level element → edit its text inline → changes write back to the source file with byte-perfect fidelity for everything you didn't touch.

**Status:** Draft. Design phase complete. Implementation broken into five parallel streams (§7).

**Owner:** peter-suggate &lt;petersuggate@gmail.com&gt;

---

## 1. Goals & non-goals

### Goals
- Pixel-faithful preview of static HTML files (CSS, fonts, images, relative paths) inside the editor.
- Click-to-edit block-level text content with native `contentEditable` feel — typing across inline tags works.
- **Lossless source preservation:** bytes outside the edited text spans are never touched. Comments, indentation, attribute quoting style, trailing whitespace all survive verbatim.
- Atomic edits that compose with VS Code's normal undo/redo and dirty-state model. One edit session ≡ one undo entry.
- Works in both VS Code (Marketplace) and Cursor (Open VSX) without per-host code paths.

### Non-goals (v1)
- Editing attributes (`href`, `src`, `alt`, `class`, `title`). → Phase 3B.
- Editing structure (delete, duplicate, reorder elements; inserting new paragraphs). → Phase 3+.
- Editing inline styles or class lists via a formatting toolbar. → Phase 3+.
- Editing files containing template syntax (Handlebars, EJS, JSX, ERB, Liquid, PHP). v1 detects and locks; preview still works.
- Rendering files that import workspace-external resources by URL (we serve workspace-rooted assets only).
- AI integration. → Phase 3A (open-architecture command, no API keys held by us).

---

## 2. Architecture

```
┌────────────────────┐         postMessage         ┌────────────────────────┐
│  Extension Host    │ ◄───────────────────────►  │  Webview (panel)       │
│  - Activation      │                             │  - Iframe host         │
│  - Commands        │                             │  - Banners / status    │
│  - Document watch  │                             │  - Relays messages     │
│  - parse5 walk     │                             └─────────┬──────────────┘
│  - applyEdit       │                                       │ postMessage
│  - HTTP server     │                                       ▼
└─────────┬──────────┘                             ┌────────────────────────┐
          │                                        │  Iframe                │
          │   http://127.0.0.1:PORT/path.html      │  - Rendered HTML       │
          └─────────────────────────────────────►  │  - Overlay UI          │
                                                   │  - contentEditable     │
                                                   │  - Edit instrumentation│
                                                   └────────────────────────┘
```

Three contexts:

- **Extension host** (Node.js): parse5 walking, file I/O, HTTP server, command registration, applyEdit pipeline.
- **Webview** (Electron renderer, sandboxed by VS Code): hosts the iframe, draws status/banner UI, relays messages between host and iframe. Holds no edit state.
- **Iframe** (same renderer, separate origin = `http://127.0.0.1:PORT`): renders the HTML being edited, hosts overlay + edit instrumentation. Cross-origin from the webview by design — same-origin within the iframe lets us postMessage and access the iframe DOM without `file://` quirks.

---

## 3. Round-trip strategy

### 3.1 Source-position splicing with parse5

On every parse:

1. Read file buffer from the live `TextDocument.getText()` (so unsaved external edits are reflected).
2. `parse5.parse(html, { sourceCodeLocationInfo: true })`.
3. Walk the document; for each `Text` node satisfying the editable rules (§3.2):
   - Record `{ nodeId, blockId, startOffset, endOffset, originalText }` where `nodeId` is the index in document order among editable text nodes.
4. Identify "block containers" — the nearest ancestor of each editable text node whose computed `display` is block-ish and which is not `<body>`. Each gets a `blockId` (also document-order index).
5. Emit `OffsetMap = { blocks, textNodes, documentVersion }` to the iframe.

On every edit commit:

1. Iframe posts `EditCommit { documentVersion, edits: [{ nodeId, newText }] }`.
2. Host validates `documentVersion === doc.version`. Mismatch → reply `StaleCommit`, instruct iframe to revert + reload.
3. Sort edits by `startOffset` descending.
4. Build a single `WorkspaceEdit` replacing `[startOffset, endOffset)` with `newText` for each edit. Right-to-left ordering keeps the remaining offsets valid through the apply.
5. `workspace.applyEdit()` with origin tag `finesse.commit` (used by the document watcher to distinguish self-edits from external changes — see §6.1).
6. Re-walk → emit fresh `OffsetMap` to iframe (no iframe reload; DOM already reflects the change visually, we're just refreshing bookkeeping).

**Why this is safe:** byte ranges outside the edited spans are never touched. Comments, whitespace, attribute quoting, and indentation survive verbatim. Diffs are minimal and reviewable.

### 3.2 Editable rules

A text node is **editable** iff:

- It contains at least one non-whitespace character.
- Its parent's tag is not in `{ script, style, noscript, template, code, pre, title }`.
  - `<pre>` / `<code>`: whitespace edits in these are usually mistakes; revisit in Phase 2.
  - `<title>`: edited via attributes panel later (Phase 3B).
- No ancestor has `contenteditable="false"` declared in source.
- The text node's source slice contains no template tokens (§5).

A **block container** is the nearest ancestor of an editable text node satisfying:

- Computed `display` ∈ `{ block, list-item, table-cell, flex, grid }`.
- Owns at least one editable text descendant.
- Is not the `<body>` itself (we don't want the entire body to become one editable region).

This rule handles tables, flex/grid layouts, and lists naturally. Inline tags inside a block (`<strong>`, `<em>`, `<code>`, `<a>`, `<kbd>`) are preserved during the contentEditable session and re-mapped to text nodes on commit.

---

## 4. Preview server

### 4.1 Lifecycle

- One singleton `http.Server` per VS Code window, started lazily on first preview activation.
- Binds to `127.0.0.1` on an ephemeral port (`server.listen(0)` then `address().port`); configurable.
- Lives until the last HTML preview panel closes, then idles for `serverIdleTimeout` (default 60s) before shutdown.

### 4.2 Routing

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | 404 (no index). |
| GET | `/<workspace-relative-path>` | Resolve against workspace root. Reject paths escaping root (`..`). HTML files: stream from `TextDocument.getText()` if open in VS Code (so unsaved edits preview), else from disk. Inject instrumentation script + offset map JSON before `</body>`. Other files: stream from disk with content-type by extension. |
| GET | `/__edit/socket` | WebSocket: server pushes `{ type: "reload" }` on external file changes. |
| GET | `/__edit/runtime.js` | The iframe instrumentation bundle (compiled from `src/iframe/`). |

### 4.3 Cache & reload

- `ETag` based on `(documentVersion, mtime)`. Iframe sends `If-None-Match` on reloads to short-circuit.
- WebSocket message `{ type: "reload" }` triggers iframe `location.reload()`.

---

## 5. Template detection

Scan each editable text node's source slice with:

```ts
const TEMPLATE_PATTERNS = [
  /\{\{[^}]*\}\}/,    // Handlebars, Vue, Mustache
  /\{%[^%]*%\}/,      // Jinja2, Liquid, Nunjucks
  /<%[^%]*%>/,        // EJS, ASP, ERB
  /\$\{[^}]*\}/,      // JS template literals
  /<\?[^?]*\?>/,      // PHP, XML processing instructions
];
```

**v1 behavior:** if *any* editable text node matches *any* pattern, the entire file is treated as templated. Show a banner: **"Finesse editing disabled: template syntax detected. Preview only."** The iframe still renders the file; click-to-edit is disabled across the board.

Per-element opt-out (always honored): elements with `data-no-edit` attribute, or any descendant of `contenteditable="false"`.

User override (Phase 2): command `finesse.editAnyway` writes `data-finesse-allow="true"` on `<html>`, after which the editability rule re-evaluates per-text-node (template-bearing text nodes still locked). Surface as a banner action.

---

## 6. Message protocol

Single source of truth: `src/shared/protocol.ts`. The webview is a transparent relay between host and iframe — it adds only its own UI events (banner dismissals, status clicks).

```ts
// ── Host → Iframe ─────────────────────────────────────────────────────────

export type OffsetMap = {
  type: "offsetMap";
  documentVersion: number;
  blocks: Array<{
    blockId: number;
    /** Tag name of the block container, lowercased. Used by overlay UI for ARIA labels. */
    tagName: string;
  }>;
  textNodes: Array<{
    nodeId: number;
    blockId: number;
    startOffset: number;
    endOffset: number;
    originalText: string;
  }>;
};

export type Reload = {
  type: "reload";
  reason: "external-edit" | "stale-commit" | "config-changed";
};

export type EditAck = {
  type: "editAck";
  documentVersion: number;
  /** New offset map shipped alongside the ack so the iframe can resume editing. */
  offsetMap: OffsetMap;
};

export type StaleCommit = {
  type: "staleCommit";
  expectedVersion: number;
  actualVersion: number;
};

export type FileMeta = {
  type: "fileMeta";
  /** Workspace-relative path of the file being previewed. */
  path: string;
  /** True iff template syntax was detected anywhere in editable text nodes. */
  isTemplated: boolean;
};

export type HostMessage = OffsetMap | Reload | EditAck | StaleCommit | FileMeta;

// ── Iframe → Host ─────────────────────────────────────────────────────────

export type EditCommit = {
  type: "editCommit";
  documentVersion: number;
  edits: Array<{ nodeId: number; newText: string }>;
};

export type EditCancel = {
  type: "editCancel";
  blockId: number;
};

export type RuntimeError = {
  type: "runtimeError";
  message: string;
  stack?: string;
};

export type Ready = { type: "ready" };

export type IframeMessage = EditCommit | EditCancel | RuntimeError | Ready;
```

### 6.1 Document-watcher self-edit detection

`workspace.applyEdit()` does not natively carry an origin tag. We approximate by:

1. Before `applyEdit`, capture `expectedVersion = doc.version + 1`.
2. The first `onDidChangeTextDocument` event after apply with `event.document.version === expectedVersion` and `event.contentChanges` matching our edit list is treated as a self-edit (no reload).
3. Any other change for the same document → external edit → `Reload { reason: "external-edit" }`.

Edge: if two of our commits race, the version-matching above is robust — each apply advances the version monotonically.

---

## 7. Phasing

### Phase 0 — Foundation (sequential; ~half day)

- Repo scaffold: `package.json` (extension manifest), `tsconfig.json`, `tsconfig.iframe.json`, `esbuild.config.mjs`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`.
- `src/shared/protocol.ts` authored and locked. **No further changes without all five Phase 1 owners signing off.**
- VS Code launch.json for the Extension Development Host.
- Fixture set: at minimum `vanilla.html`, `with-comments.html`, `inline-tags.html`, `tables.html`, `lists.html`, `pre-and-code.html`, `templated-handlebars.html`. These are the contract tests for §3.2 and §5.
- CI skeleton: lint + typecheck + package (.vsix output).

### Phase 1 — Five parallel streams

After Phase 0, these five streams run concurrently. Each owns its directory tree and consumes only `src/shared/protocol.ts` and the fixture corpus.

| Stream | Path | Deliverable |
|---|---|---|
| **1A — Extension host** | `src/host/extension.ts`, `src/host/commands.ts`, `src/host/panel.ts`, `src/host/applyEdit.ts`, `src/host/documentWatcher.ts` | Activation, commands (`finesse.openPreview`, `…closePreview`), panel lifecycle, document-watcher with self-edit discrimination (§6.1), applyEdit pipeline (right-to-left splice with version validation). |
| **1B — HTTP server** | `src/host/server/server.ts`, `src/host/server/inject.ts`, `src/host/server/reloadSocket.ts` | Port management, workspace-rooted serving, traversal protection, ETag, instrumentation injection at `</body>`, WebSocket reload channel. |
| **1C — parse5 walker** | `src/host/parse/walkEditable.ts`, `src/host/parse/templateDetect.ts`, `src/host/parse/editabilityRules.ts` | Pure functions: `walkEditable(html) → OffsetMap`, template detection, editability rules. Tested against the fixture corpus with snapshot tests (since we skip `.test.tsx`-style behavior tests, these are golden-file comparisons run from a single `pnpm verify` script). |
| **1D — Iframe instrumentation** | `src/iframe/main.ts`, `src/iframe/overlay.ts`, `src/iframe/editSession.ts`, `src/iframe/diff.ts`, `src/iframe/pasteSanitizer.ts` | Overlay UI (hover outline, selection outline), block-container detection from offsetMap blocks, click→`contentEditable=true`, blur/Enter/Esc commit, snapshot-vs-current-DOM diff producing per-textnode edits, paste sanitizer (force `text/plain`), Esc-revert. Compiled as a separate esbuild target → `dist/iframe-runtime.js`. |
| **1E — Webview shell** | `src/webview/index.html`, `src/webview/main.ts`, `src/webview/banners.ts`, `src/webview/status.ts` | Hosts the iframe element, postMessage relay between host and iframe, status bar (file name, document version, server port, "Editing locked" if templated), banners (template-detected with override action, stale-reload notice, runtime errors). |

**End-of-Phase-1 integration milestone:** open `fixtures/vanilla.html`, click the first `<p>`, type "hello", blur. Assert the file diff is exactly the typed text replacing the original; nothing else changed. Repeat for `inline-tags.html` (verify `<strong>` survives), `with-comments.html` (verify comments survive), `tables.html` (verify `<td>` editability).

### Phase 2 — Five parallel polish streams

| Stream | Deliverable |
|---|---|
| **2A. External-edit hot-reload** | Wire §6.1 end-to-end: external save / git checkout / undo in source pane → iframe reload. |
| **2B. Template detection UX** | Banner with override action (`finesse.editAnyway`), per-element `data-no-edit` honored, settings for custom token list. |
| **2C. Settings surface** | All settings in §9 surfaced via `package.json` `contributes.configuration` with proper schemas. |
| **2D. Resource serving correctness** | Relative `<link>`, `<script>`, `<img>`, `<source>`, `<video>`, `@font-face url(...)` resolved against workspace root. Clear error toast if paths escape workspace. Reload preview on referenced CSS/JS file changes. |
| **2E. A11y + keyboard** | Tab/Shift-Tab between blocks, Enter to enter edit, Esc to cancel, screen-reader landmarks, `aria-live` for banners. |

### Phase 3 — Distribution + extensions

| Stream | Deliverable |
|---|---|
| **3A. Cursor Cmd-K passthrough** | Open-architecture command `finesse.actOnSelection(range)`. Setting `finesse.aiCommand` (string command id, default detected at activation by inspecting installed extensions). Right-click in preview → "Rewrite this with AI". |
| **3B. Attribute editing** | Property panel docked beside selection: edit `href`, `src`, `alt`, `class`, `title`. Same source-splicing strategy at attribute-value granularity. |
| **3C. Marketplace + Open VSX publishing** | `vsce publish` and `ovsx publish` in CI on tagged commits. README, screenshots, demo GIF. |
| **3D. Optional telemetry** | Opt-in only, error reports without payloads. Use VS Code's `TelemetryLogger` API. |

---

## 8. Repository layout

```
finesse-html/
├── package.json                  # extension manifest
├── tsconfig.json
├── tsconfig.iframe.json          # separate target for iframe bundle
├── esbuild.config.mjs
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── .vscode/
│   └── launch.json               # F5 launches Extension Development Host
├── .github/workflows/
│   ├── ci.yml                    # lint + typecheck + package
│   └── release.yml               # publish to both registries on tag
├── src/
│   ├── shared/
│   │   └── protocol.ts           # SOURCE OF TRUTH for messages
│   ├── host/
│   │   ├── extension.ts          # activate / deactivate
│   │   ├── commands.ts
│   │   ├── panel.ts              # webview panel lifecycle
│   │   ├── documentWatcher.ts
│   │   ├── applyEdit.ts          # right-to-left splice pipeline
│   │   ├── parse/
│   │   │   ├── walkEditable.ts
│   │   │   ├── templateDetect.ts
│   │   │   └── editabilityRules.ts
│   │   └── server/
│   │       ├── server.ts
│   │       ├── inject.ts
│   │       └── reloadSocket.ts
│   ├── iframe/
│   │   ├── main.ts
│   │   ├── overlay.ts
│   │   ├── editSession.ts
│   │   ├── diff.ts
│   │   └── pasteSanitizer.ts
│   └── webview/
│       ├── index.html
│       ├── main.ts
│       ├── banners.ts
│       └── status.ts
├── fixtures/                     # contract test corpus
│   ├── vanilla.html
│   ├── with-comments.html
│   ├── inline-tags.html
│   ├── tables.html
│   ├── lists.html
│   ├── pre-and-code.html
│   └── templated-handlebars.html
├── SPEC.md                       # this file
└── README.md
```

---

## 9. Settings reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `finesse.port` | `number \| "auto"` | `"auto"` | HTTP server port, or auto-allocate. |
| `finesse.editableElements` | `string[]` | computed | Override block-container selector list. |
| `finesse.templateTokens` | `string[]` (regex sources) | see §5 | Patterns marking files as templated. |
| `finesse.serverIdleTimeout` | `number` (ms) | `60000` | Idle shutdown after last preview closes. |
| `finesse.reloadDebounceMs` | `number` | `150` | Debounce for external-edit reload triggers. |
| `finesse.openOnHtmlOpen` | `boolean` | `false` | Auto-open preview when an HTML file opens. |
| `finesse.aiCommand` | `string` | auto-detect | Phase 3A: command id to invoke for "Rewrite with AI". |

---

## 10. Open questions / future work

- **`<pre>` and `<code>` editing.** Currently locked. Phase 2 might introduce a "code mode" using a `<textarea>` overlay rather than contentEditable, since contentEditable normalizes whitespace aggressively.
- **Inline tag preservation under contentEditable.** Browsers normalize aggressively (e.g., `<b>` → `<strong>`, `<i>` → `<em>` in some implementations; `<div>` insertion on Enter). The diff layer (1D) needs targeted normalization rules; track in a `normalization.ts` module if behaviors diverge across Chromium versions.
- **Multi-panel.** Two HTML files open simultaneously: server is singleton, panels are independent. Each panel has its own iframe with its own offsetMap subscription. Should work without special-casing — verify in Phase 1 integration.
- **Performance on large files.** Re-parse + re-emit on every commit is O(n) in file size. For 5MB+ HTML files (rare in docs use case) we may want incremental parse. Defer until we have a concrete user with this profile.
- **External CSS/JS edited externally.** Phase 2D should also reload on workspace file changes for any `.css` / `.js` referenced by the active HTML, not only the HTML itself.
- **Save semantics for unsaved files.** If the HTML buffer is dirty in VS Code, our HTTP server already serves `getText()`. But the user might expect Cmd+S to also clear the dirty state — confirm: yes, Cmd+S behaves normally; we only ever apply `WorkspaceEdit`, never write files directly.

---

## 11. Decision log

The Q&A that produced this spec.

| # | Question | Decision |
|---|---|---|
| Q1 | Editing scope | Text content only in v1. Attributes in Phase 3B. Structure / styles deferred. |
| Q2 | Round-trip strategy | parse5 with `sourceCodeLocationInfo` → record `(start, end)` per editable text node → splice on commit. Right-to-left ordering. Byte-perfect for untouched regions. |
| Q3 | Preview rendering | Local HTTP server on `127.0.0.1` + iframe. Live Preview architecture pattern. |
| Q4 | Editable unit | Block-container `contentEditable`. On commit, walk text nodes, diff vs. snapshot, emit per-node splices. |
| Q5 | Commit semantics | On blur / Enter / Esc. One `WorkspaceEdit` per session. Composes with VS Code's native undo and dirty-state. Cmd+S behaves normally. |
| Q6 | Staleness | Versioned commits + reject + reload. `documentVersion` mismatch → `StaleCommit` reply, iframe reverts and reloads. External edits trigger reload. |
| Q7 | Templating | Plain HTML only in v1. Detect tokens; if any present, banner + lock all editing (preview still works). Per-element `data-no-edit` always honored. |
| Q8 | AI integration | None in v1. Phase 3A: open-architecture command `finesse.actOnSelection`, setting `finesse.aiCommand`. We never hold API keys. |
| Q9 | Repo & distribution | Personal standalone repo at `/Users/petersuggate/code/anjuna/finesse-html`. Sideload during Phase 1. Publish to VS Code Marketplace + Open VSX after Phase 1 lands. |
| Q10 | Phasing | Phase 0 sequential (foundation). Phase 1 = 5 parallel streams against locked protocol. Phase 2 = 5 parallel polish streams. Phase 3 = distribution + extensions. |
