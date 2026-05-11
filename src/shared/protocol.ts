// LOCKED CONTRACT — modifications require sign-off from all five Phase 1 stream owners.

// ── Host → Iframe ─────────────────────────────────────────────────────────

export type OffsetMap = {
  type: 'offsetMap';
  documentVersion: number;
  /** Every selectable/removable element in document order. Includes blocks. */
  elements: Array<{
    elementId: number;
    tagName: string;
    /** Source offset of the element's opening `<` (inclusive). */
    startOffset: number;
    /** Source offset just past the element's closing `>` (exclusive). */
    endOffset: number;
  }>;
  /** Subset of elements that are text-editing block containers. */
  blocks: Array<{
    blockId: number;
    /** Pointer into `elements`. */
    elementId: number;
    tagName: string;
    /** Source offset just after the opening tag's `>`. Inner-content start. */
    innerStartOffset?: number;
    /** Source offset of the closing tag's leading `<`. Inner-content end. */
    innerEndOffset?: number;
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
  type: 'reload';
  reason: 'external-edit' | 'stale-commit' | 'config-changed';
};

export type EditAck = {
  type: 'editAck';
  documentVersion: number;
  /** New offset map shipped alongside the ack so the iframe can resume editing. */
  offsetMap: OffsetMap;
};

export type StaleCommit = {
  type: 'staleCommit';
  expectedVersion: number;
  actualVersion: number;
};

export type FileMeta = {
  type: 'fileMeta';
  /** Workspace-relative path of the file being previewed. */
  path: string;
  /** True iff template syntax was detected anywhere in editable text nodes. */
  isTemplated: boolean;
};

export type DocumentState = {
  type: 'documentState';
  /** Whether the underlying TextDocument has unsaved changes. */
  isDirty: boolean;
  /** Whether host-side auto-save-after-commit is currently enabled. */
  autoSave: boolean;
  /** Whether the preview has a Finesse edit available to undo. */
  canUndo: boolean;
  /** Whether the preview has a Finesse edit available to redo. */
  canRedo: boolean;
};

export type AgentSelectionState = {
  type: 'agentSelectionState';
  selected: boolean;
  label?: string;
  agentRunning: boolean;
};

export type AgentConnectionState = {
  type: 'agentConnectionState';
  providerId: 'cursor';
  connected: boolean;
  /** Where the key came from when connected. */
  source?: 'secret' | 'environment';
};

export type AgentRunStatus = {
  type: 'agentRunStatus';
  providerId: 'cursor';
  /**
   * `starting`: agent run is initialising
   * `output`: incremental assistant output (append `text` to the running log)
   * `status`: a status line from the provider (status message)
   * `done`: run finished successfully (final `text` is the result, if any)
   * `error`: run failed (`text` is a human-readable message)
   */
  phase: 'starting' | 'status' | 'output' | 'done' | 'error';
  text?: string;
};

export type HostMessage =
  | OffsetMap
  | Reload
  | EditAck
  | StaleCommit
  | FileMeta
  | DocumentState
  | AgentSelectionState
  | AgentConnectionState
  | AgentRunStatus;

// ── Iframe → Host ─────────────────────────────────────────────────────────

export type EditCommit = {
  type: 'editCommit';
  documentVersion: number;
  edits: Array<{ nodeId: number; newText: string }>;
};

export type EditCancel = {
  type: 'editCancel';
  blockId: number;
};

export type EditRemove = {
  type: 'editRemove';
  documentVersion: number;
  /** Element ids to remove from source, in any order. Host splices right-to-left. */
  elementIds: number[];
};

/**
 * Replace the inner content of a single block with a new HTML fragment.
 * Used when a structural edit (e.g. inline formatting) changes the block's
 * text-node identity, so the per-text-node {@link EditCommit} pipe is unsafe.
 *
 * The host sanitizes `newInnerHtml` against an allowlist before splicing.
 * Bytes outside the block's `innerStartOffset..innerEndOffset` range are
 * preserved verbatim.
 */
export type EditBlockHtml = {
  type: 'editBlockHtml';
  documentVersion: number;
  blockId: number;
  newInnerHtml: string;
  /** Optional: also rename the block's tag (e.g. p → h2) atomically. */
  newTagName?: string;
};

/**
 * Change a block's tag name (e.g. p → h2). Inner content is preserved
 * verbatim from source; only the opening and closing tags are rewritten.
 */
export type EditBlockTag = {
  type: 'editBlockTag';
  documentVersion: number;
  blockId: number;
  /** Lowercase tag name. Must be in the allowlist (p, h1..h6). */
  newTagName: string;
};

/**
 * Surgically mutate one or more attributes on a single element. For each
 * key in `attrs`:
 *   - string value → set/replace the attribute
 *   - null → remove the attribute
 *   - missing key → leave untouched
 *
 * The host splices only the affected attribute spans; other attributes
 * (including their original quoting and whitespace) are preserved verbatim.
 * Newly added attributes are appended to the end of the opening tag.
 */
export type EditElementAttrs = {
  type: 'editElementAttrs';
  documentVersion: number;
  elementId: number;
  attrs: Record<string, string | null>;
};

export type RuntimeError = {
  type: 'runtimeError';
  message: string;
  stack?: string;
};

export type Ready = { type: 'ready' };

/** Iframe asks host to save the underlying document (Cmd+S inside the preview). */
export type SaveRequest = { type: 'saveRequest' };

/** Iframe asks host to undo the most recent committed edit. */
export type UndoRequest = { type: 'undoRequest' };

/** Iframe asks host to redo the most recently undone edit. */
export type RedoRequest = { type: 'redoRequest' };

/** Iframe asks host to open the editor command palette. */
export type CommandPaletteRequest = { type: 'commandPaletteRequest' };

export interface ElementStyleSnapshot {
  /** Raw `style="…"` attribute value, or null if absent. */
  inlineStyle: string | null;
  /** Subset of getComputedStyle(el) the side panel populates from. */
  computed: {
    display: string;
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
    marginTop: string;
    marginRight: string;
    marginBottom: string;
    marginLeft: string;
    borderTopWidth: string;
    borderTopStyle: string;
    borderTopColor: string;
    borderTopLeftRadius: string;
    backgroundColor: string;
    flexDirection: string;
    justifyContent: string;
    alignItems: string;
    flexWrap: string;
    rowGap: string;
    gridTemplateColumns: string;
    gridTemplateRows: string;
  };
}

export type ElementSelectionSnapshot = {
  documentVersion: number;
  elementId: number;
  blockId?: number;
  tagName: string;
  domPath: string;
  selectorHints: string[];
  textPreview: string;
  outerHtmlPreview: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Inline + computed styles for the side panel. */
  styles: ElementStyleSnapshot;
};

export type ElementSelectionChanged = {
  type: 'elementSelectionChanged';
  selection: ElementSelectionSnapshot | null;
};

export type IframeMessage =
  | EditCommit
  | EditCancel
  | EditRemove
  | EditBlockHtml
  | EditBlockTag
  | EditElementAttrs
  | RuntimeError
  | Ready
  | SaveRequest
  | UndoRequest
  | RedoRequest
  | CommandPaletteRequest
  | ElementSelectionChanged;

// ── Webview (chrome) → Iframe ─────────────────────────────────────────────
//
// Messages the surrounding webview chrome posts directly into the iframe,
// without going through the extension host. Used by the right-hand style
// panel: it asks the iframe to apply an attribute mutation locally
// (optimistic DOM update) and forward the canonical edit commit to the host.

export type PanelStyleEdit = {
  type: 'panelStyleEdit';
  documentVersion: number;
  elementId: number;
  attrs: Record<string, string | null>;
};

export type ChromeIframeMessage = PanelStyleEdit;

/** Everything the iframe's window-message listener may receive. */
export type IframeInboundMessage = HostMessage | ChromeIframeMessage;

// ── Webview (chrome) → Host ───────────────────────────────────────────────

/**
 * Messages sent from the webview chrome (status bar, banners, popovers) to the
 * host. The iframe sends {@link IframeMessage}s instead; these come from
 * surrounding UI that lives in the webview itself.
 */
export type WebviewActionMessage =
  | { type: '__webview_action'; action: 'editAnyway' }
  | { type: '__webview_action'; action: 'save' }
  | { type: '__webview_action'; action: 'discard' }
  | { type: '__webview_action'; action: 'setAutoSave'; value: boolean }
  | { type: '__webview_action'; action: 'undo' }
  | { type: '__webview_action'; action: 'redo' }
  | { type: '__webview_action'; action: 'commandPalette' }
  | { type: '__webview_action'; action: 'openCursorDashboard' }
  | { type: '__webview_action'; action: 'saveApiKey'; value: string }
  | { type: '__webview_action'; action: 'forgetApiKey' }
  | { type: '__webview_action'; action: 'runAgent'; value: string };
