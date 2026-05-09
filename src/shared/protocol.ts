// LOCKED CONTRACT — modifications require sign-off from all five Phase 1 stream owners.

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
