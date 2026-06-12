// LOCKED CONTRACT — modifications require sign-off from all five Phase 1 stream owners.

// ── Host → Iframe ─────────────────────────────────────────────────────────

export type OffsetMap = {
  type: 'offsetMap';
  /** Workspace-relative path this map describes. Older harnesses may omit it. */
  path?: string;
  /** Optional render-source metadata. HTML callers can ignore this. */
  react?: ReactOffsetMetadata;
  documentVersion: number;
  /** Every selectable/removable element in document order. Includes blocks. */
  elements: Array<{
    elementId: number;
    tagName: string;
    /** Source offset of the element's opening `<` (inclusive). */
    startOffset: number;
    /** Source offset just past the element's closing `>` (exclusive). */
    endOffset: number;
    /** Workspace-relative source path for multi-file render modes. */
    sourcePath?: string;
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
    /** Workspace-relative source path for multi-file render modes. */
    sourcePath?: string;
  }>;
  textNodes: Array<{
    nodeId: number;
    blockId: number;
    startOffset: number;
    endOffset: number;
    originalText: string;
    /** Workspace-relative source path for multi-file render modes. */
    sourcePath?: string;
  }>;
};

export type ReactEditLockReason =
  | 'dynamic-expression'
  | 'repeated-source-instance'
  | 'missing-source-file'
  | 'unsupported-jsx-attribute'
  | 'css-source-unavailable';

export type ReactOffsetMetadata = {
  mode: 'react';
  lockedElementIds: number[];
  locks: Array<{
    elementId: number;
    reason: ReactEditLockReason;
  }>;
  elements: Array<{
    elementId: number;
    sourcePath: string;
    openNameStartOffset: number;
    openNameEndOffset: number;
    closeNameStartOffset?: number;
    closeNameEndOffset?: number;
    openingEndOffset: number;
    innerStartOffset?: number;
    innerEndOffset?: number;
    attributes: Array<{
      name: string;
      startOffset: number;
      endOffset: number;
      valueStartOffset?: number;
      valueEndOffset?: number;
      kind: 'string' | 'expression' | 'bare';
    }>;
  }>;
  textNodes: Array<{
    nodeId: number;
    sourcePath: string;
  }>;
  blocks: Array<{
    blockId: number;
    sourcePath: string;
    staticInner: boolean;
  }>;
};

export type Reload = {
  type: 'reload';
  reason: 'external-edit' | 'stale-commit' | 'config-changed' | 'discard';
};

export type EditAck = {
  type: 'editAck';
  /** Workspace-relative path whose edit was acknowledged. */
  path?: string;
  documentVersion: number;
  /** New offset map shipped alongside the ack so the iframe can resume editing. */
  offsetMap: OffsetMap;
};

export type StaleCommit = {
  type: 'staleCommit';
  path?: string;
  expectedVersion: number;
  actualVersion: number;
};

export type EditFailed = {
  type: 'editFailed';
  path?: string;
  message: string;
};

export type PreviewDiagnostic = {
  type: 'previewDiagnostic';
  path?: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
};

export type FileMeta = {
  type: 'fileMeta';
  /** Workspace-relative path of the file being previewed. */
  path: string;
  /** True iff template syntax was detected anywhere in editable text nodes. */
  isTemplated: boolean;
  /** How the preview was rendered. Omitted means legacy HTML mode. */
  renderMode?: 'html' | 'templateLiteral' | 'react';
};

export type DocumentState = {
  type: 'documentState';
  /** Active workspace-relative path this state describes. */
  path?: string;
  /** Whether the underlying TextDocument has unsaved changes. */
  isDirty: boolean;
  /** Whether the preview has a Finesse edit available to undo. */
  canUndo: boolean;
  /** Whether the preview has a Finesse edit available to redo. */
  canRedo: boolean;
};

export type AgentProviderId = 'cursor' | 'claude-code';

export type AgentSelectionState = {
  type: 'agentSelectionState';
  selected: boolean;
  label?: string;
  agentRunning: boolean;
};

export type AgentProviderState = {
  type: 'agentProviderState';
  /** Which provider is currently active for the Ask Agent panel. */
  providerId: AgentProviderId;
  /** Model id the active provider will use for the next run. */
  model?: string;
};

export type AgentConnectionState = {
  type: 'agentConnectionState';
  providerId: AgentProviderId;
  connected: boolean;
  /** Where the key came from when connected. */
  source?: 'secret' | 'environment';
};

export type AgentRunStatus = {
  type: 'agentRunStatus';
  providerId: AgentProviderId;
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
  | EditFailed
  | PreviewDiagnostic
  | FileMeta
  | DocumentState
  | AgentSelectionState
  | AgentProviderState
  | AgentConnectionState
  | AgentRunStatus;

// ── Iframe → Host ─────────────────────────────────────────────────────────

export type DocumentScopedMessage = {
  /** Workspace-relative path the message targets. Optional for legacy callers. */
  path?: string;
};

export type EditCommit = DocumentScopedMessage & {
  type: 'editCommit';
  documentVersion: number;
  edits: Array<{ nodeId: number; newText: string }>;
};

export type EditCancel = DocumentScopedMessage & {
  type: 'editCancel';
  blockId: number;
};

export type EditRemove = DocumentScopedMessage & {
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
export type EditBlockHtml = DocumentScopedMessage & {
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
export type EditBlockTag = DocumentScopedMessage & {
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
export type EditElementAttrs = DocumentScopedMessage & {
  type: 'editElementAttrs';
  documentVersion: number;
  elementId: number;
  attrs: Record<string, string | null>;
};

export type RuntimeError = {
  type: 'runtimeError';
  source?: 'finesse' | 'page';
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
};

export type ReactDomDiscovery = DocumentScopedMessage & {
  type: 'reactDomDiscovery';
  documentVersion?: number;
  elements: Array<{
    elementId: number;
    loc: string;
    tagName: string;
    occurrence: number;
  }>;
};

export type Ready = DocumentScopedMessage & {
  type: 'ready';
  documentVersion?: number;
};

/** Iframe asks host to save the underlying document (Cmd+S inside the preview). */
export type SaveRequest = DocumentScopedMessage & { type: 'saveRequest' };

/** Iframe asks host to undo the most recent committed edit. */
export type UndoRequest = DocumentScopedMessage & { type: 'undoRequest' };

/** Iframe asks host to redo the most recently undone edit. */
export type RedoRequest = DocumentScopedMessage & { type: 'redoRequest' };

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

export interface ClassRuleDeclaration {
  property: string;
  value: string;
  /** Whether the declaration ends with `!important`. */
  important: boolean;
}

export interface ClassRuleBlock {
  /**
   * Full selector text for the editable rule, e.g. `.lede` or `.hero .lede`.
   * The rule is surfaced for a class only when at least one selector arm
   * matches the selected element and references that class token.
   */
  selector: string;
  declarations: ClassRuleDeclaration[];
}

/** One step in the ancestor chain of a selected element. */
export type AncestorRef = {
  elementId: number;
  tagName: string;
  /** `id` attribute if present. */
  id?: string;
  /** Up to a few class tokens for display (not necessarily the full list). */
  classList?: string[];
};

export type ElementSelectionSnapshot = {
  /** Workspace-relative path of the source file containing this element. */
  path?: string;
  documentVersion: number;
  elementId: number;
  blockId?: number;
  tagName: string;
  domPath: string;
  selectorHints: string[];
  /**
   * Ancestor chain leading up to (and excluding) this element, ordered
   * shallowest → deepest (i.e. document root first, immediate parent last).
   * Only includes ancestors the iframe tracks via `data-finesse-id`. Consumers
   * may render breadcrumbs (left-to-right) or a parent dropdown.
   */
  ancestors?: AncestorRef[];
  /** Tokens from this element's `class` attribute, in source order. */
  classList: string[];
  /**
   * Sorted, deduped union of every class token used anywhere in the document.
   * Drives the side panel's class autocomplete — we only suggest classes the
   * file already references (i.e. ones likely to have CSS attached).
   */
  classCatalog: string[];
  /**
   * For each class on this element, editable CSS rules whose selectors match
   * the selected element and mention that class token. This includes contextual
   * selectors such as `.hero .lede`, not only standalone `.lede` rules.
   * Classes with no matching rule simply don't appear as keys.
   */
  classRules: Record<string, ClassRuleBlock[]>;
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

/**
 * Edit a single CSS declaration inside a `<style>` block in the same source
 * file. Used by the per-class sections in the side panel. Routed through the
 * iframe so the chrome doesn't have to talk directly to the host.
 */
export type EditCssDeclaration = DocumentScopedMessage & {
  type: 'editCssDeclaration';
  documentVersion: number;
  selector: string;
  property: string;
  /** `null` removes the declaration entirely. */
  value: string | null;
};

export type IframeMessage =
  | ReactDomDiscovery
  | EditCommit
  | EditCancel
  | EditRemove
  | EditBlockHtml
  | EditBlockTag
  | EditElementAttrs
  | EditCssDeclaration
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

/**
 * Chrome asks the iframe to apply a CSS declaration edit. The iframe updates
 * its live CSSOM optimistically (so the preview reflects the change before the
 * host responds) and forwards an {@link EditCssDeclaration} to the host to
 * splice the source file.
 */
export type PanelCssEdit = {
  type: 'panelCssEdit';
  documentVersion: number;
  selector: string;
  property: string;
  value: string | null;
};

/**
 * Chrome asks the iframe to programmatically select the element with the given
 * id (e.g. user clicked a breadcrumb in the side panel). The iframe updates
 * its selection state and re-announces it back to the chrome.
 */
export type PanelSelectElement = {
  type: 'panelSelectElement';
  elementId: number;
};

export type ChromeIframeMessage = PanelStyleEdit | PanelCssEdit | PanelSelectElement;

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
  | { type: '__webview_action'; action: 'undo' }
  | { type: '__webview_action'; action: 'redo' }
  | { type: '__webview_action'; action: 'commandPalette' }
  | { type: '__webview_action'; action: 'openCursorDashboard' }
  | { type: '__webview_action'; action: 'openClaudeDocs' }
  | { type: '__webview_action'; action: 'saveApiKey'; value: string }
  | { type: '__webview_action'; action: 'forgetApiKey' }
  | { type: '__webview_action'; action: 'selectAgentProvider'; providerId: AgentProviderId }
  | { type: '__webview_action'; action: 'changeAgentModel' }
  | { type: '__webview_action'; action: 'runAgent'; value: string; providerId: AgentProviderId };
