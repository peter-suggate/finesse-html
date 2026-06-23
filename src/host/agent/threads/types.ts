import type { AgentProviderId } from '../types';
import type { ElementSelectionSnapshot } from '../../../shared/protocol';

/**
 * Durable identity for an edit thread's target element.
 *
 * `elementId` is renumbered on every reparse, so it cannot anchor a lingering
 * edit. Instead we persist the structural descriptors the iframe already
 * computes for a selection (`domPath`, `selectorHints`, `tagName`,
 * `textPreview`) and resolve them back to a *current* `elementId` just before
 * each run. `lastKnown*` is a non-authoritative fast path used only when the
 * document version has not changed since the anchor was captured.
 */
export interface ElementAnchor {
  /** Workspace-relative source path. Pairs with `PageState.relativePath`. */
  path: string;
  /** Structural selector, e.g. `body > main > section:nth-of-type(2) > h1`. */
  domPath: string;
  /** Order-significant hints: `['#hero', '.lede', '[aria-label="…"]']`. */
  selectorHints: string[];
  tagName: string;
  /** Trimmed innerText preview, for fuzzy disambiguation and UI labels. */
  textPreview: string;
  /** Fast-path cache: the elementId/version this anchor last resolved to. */
  lastKnownElementId?: number;
  lastKnownVersion?: number;
}

export type EditThreadStatus =
  /** Composer open, no run requested yet. */
  | 'idle'
  /** Enqueued, waiting for the active run to finish. */
  | 'queued'
  /** Currently the one active run (panel-wide). */
  | 'running'
  /** User paused; removed from the queue, all state retained. */
  | 'paused'
  /** Last run finished successfully. */
  | 'done'
  /** Last run failed (see `error`). */
  | 'error'
  /** Restored/aged-out: anchor no longer resolves to a live element. */
  | 'stale';

export interface SteeringMessage {
  id: string;
  text: string;
  at: number;
  /** True if added while a run was in flight (applies to the next run). */
  midRun: boolean;
}

export interface EditThread {
  id: string;
  anchor: ElementAnchor;
  status: EditThreadStatus;
  /** Provider pinned at creation. */
  providerId: AgentProviderId;
  /** Ordered instructions: first is the initial prompt, rest are steers. */
  prompts: SteeringMessage[];
  /** Tail of the provider run log (status + output), capped. */
  runLogTail: string;
  error?: string;
  errorKind?: 'auth';
  createdAt: number;
  lastRunAt?: number;
  /** Bumped on each (re)enqueue; guards against late sink callbacks. */
  runEpoch: number;
}

/** Max characters retained in {@link EditThread.runLogTail}. */
export const MAX_RUN_LOG_CHARS = 4000;

/** Trim a running log to the last {@link MAX_RUN_LOG_CHARS} characters. */
export function capRunLog(text: string): string {
  return text.length > MAX_RUN_LOG_CHARS ? text.slice(-MAX_RUN_LOG_CHARS) : text;
}

/**
 * Build a durable anchor from a live selection snapshot. Seeds the fast-path
 * cache with the selection's current elementId/version.
 */
export function anchorFromSelection(
  selection: ElementSelectionSnapshot,
  fallbackPath: string,
): ElementAnchor {
  return {
    path: selection.path ?? fallbackPath,
    domPath: selection.domPath,
    selectorHints: selection.selectorHints,
    tagName: selection.tagName,
    textPreview: selection.textPreview,
    lastKnownElementId: selection.elementId,
    lastKnownVersion: selection.documentVersion,
  };
}

/**
 * Fold a thread's prompt history into a single instruction string for the
 * one-shot providers. The initial prompt leads; steers are appended as
 * explicit follow-up instructions in the order they were added.
 */
export function foldPrompts(prompts: SteeringMessage[]): string {
  const texts = prompts.map((p) => p.text.trim()).filter(Boolean);
  if (texts.length === 0) return '';
  const [first, ...rest] = texts;
  if (rest.length === 0) return first;
  const followups = rest
    .map((t, i) => `Additional instruction ${i + 1}:\n${t}`)
    .join('\n\n');
  return `${first}\n\n${followups}`;
}

/** Human-friendly label for a thread's target, for logs and UI. */
export function threadLabel(thread: EditThread): string {
  const preview = thread.anchor.textPreview.trim();
  const tag = thread.anchor.tagName.toLowerCase();
  if (preview) {
    const short = preview.length > 32 ? `${preview.slice(0, 31)}…` : preview;
    return `${tag} · ${short}`;
  }
  return tag;
}
