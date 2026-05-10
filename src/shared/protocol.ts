// LOCKED CONTRACT — modifications require sign-off from all five Phase 1 stream owners.

// ── Host → Iframe ─────────────────────────────────────────────────────────

export type OffsetMap = {
  type: "offsetMap";
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

export type DocumentState = {
  type: "documentState";
  /** Whether the underlying TextDocument has unsaved changes. */
  isDirty: boolean;
  /** Whether host-side auto-save-after-commit is currently enabled. */
  autoSave: boolean;
};

export type HostMessage =
  | OffsetMap
  | Reload
  | EditAck
  | StaleCommit
  | FileMeta
  | DocumentState;

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

export type EditRemove = {
  type: "editRemove";
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
  type: "editBlockHtml";
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
  type: "editBlockTag";
  documentVersion: number;
  blockId: number;
  /** Lowercase tag name. Must be in the allowlist (p, h1..h6). */
  newTagName: string;
};

export type RuntimeError = {
  type: "runtimeError";
  message: string;
  stack?: string;
};

export type Ready = { type: "ready" };

/** Iframe asks host to save the underlying document (Cmd+S inside the preview). */
export type SaveRequest = { type: "saveRequest" };

export type IframeMessage =
  | EditCommit
  | EditCancel
  | EditRemove
  | EditBlockHtml
  | EditBlockTag
  | RuntimeError
  | Ready
  | SaveRequest;
