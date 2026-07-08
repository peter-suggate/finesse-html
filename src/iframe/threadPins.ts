import { modKey, SEND_KEY_LABEL } from '../shared/keys';
import type {
  AgentThreadRunStatus,
  AgentThreadsState,
  EditThreadStatus,
  EditThreadView,
  ElementSelectionSnapshot,
  IframeMessage,
  ResolveAnchor,
  ThreadAction,
} from '../shared/protocol';

/**
 * In-preview "edit thread" layer: a numbered, status-colored pin anchored over
 * each thread's target element, plus an inline composer popover for steering,
 * running, pausing, resuming, restarting, and deleting that thread.
 *
 * The page literally carries its in-progress AI edits. Pins reposition with
 * the page (scroll/resize) and resolve their own target element from the
 * durable `domPath` anchor, so they survive reparses that renumber elementIds.
 *
 * All chrome lives under ids prefixed `finesse-` so the overlay's canvas-click
 * suppression auto-excludes it (see `isInOverlayUi` in overlay.ts).
 */
export interface ThreadPinsController {
  applyThreadsState(state: AgentThreadsState): void;
  applyRunStatus(status: AgentThreadRunStatus): void;
  /** Answer a host anchor-resolution request with a fresh selection snapshot. */
  resolveAnchor(msg: ResolveAnchor): void;
  /** Open a thread's composer and scroll its element into view. */
  focusThread(threadId: string): void;
  /**
   * Open a fresh "new edit" composer anchored to `el`. Submitting it creates a
   * new edit thread scoped to that element — the in-preview way to start an
   * edit without going to the sidebar.
   */
  startNewEdit(el: HTMLElement): void;
  destroy(): void;
}

/** Minimal surface the pins need from the edit session. */
export interface ThreadPinsSession {
  describeElement(el: HTMLElement): ElementSelectionSnapshot | null;
}

export interface SetupThreadPinsOpts {
  session: ThreadPinsSession;
  postToParent(msg: IframeMessage): void;
  /** Active source path; pins only show for threads matching it. */
  currentPath(): string;
}

/** Persistent composer DOM, reused across streaming updates (never rebuilt). */
interface ComposerEls {
  threadId: string;
  root: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  target: HTMLElement;
  history: HTMLElement;
  error: HTMLElement;
  log: HTMLElement;
  textarea: HTMLTextAreaElement;
  hint: HTMLElement;
  actions: HTMLElement;
  /** Prompt count the history block was last built for. */
  historyKey: number;
  /** Last status the action row was built for, so we rebuild only on change. */
  actionsKey: string;
}

/** Transient "new edit" composer DOM, before a thread exists. */
interface DraftComposerEls {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
}

const STATUS_COLORS: Record<EditThreadStatus, string> = {
  idle: '#1e6fd9',
  queued: '#8a6d1f',
  running: '#1e6fd9',
  paused: '#6b7280',
  done: '#2f9e57',
  error: '#d14545',
  stale: '#b9772b',
};

const STATUS_LABELS: Record<EditThreadStatus, string> = {
  idle: 'Draft',
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  error: 'Failed',
  stale: 'Detached',
};

export function setupThreadPins(opts: SetupThreadPinsOpts): ThreadPinsController {
  injectCss();

  const layer = document.createElement('div');
  layer.id = 'finesse-thread-pins';
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483644',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(layer);

  let threads: EditThreadView[] = [];
  let activeThreadId: string | null = null;
  let openThreadId: string | null = null;
  /** Draft composer text per thread, preserved across re-renders. */
  const drafts = new Map<string, string>();

  // Live DOM kept across updates so streaming snapshots never tear down a pin
  // or the open composer mid-interaction (that was eating clicks and focus).
  const pinEls = new Map<string, HTMLElement>();
  let composer: ComposerEls | null = null;
  // A transient "new edit" composer, not yet backed by a thread.
  let draftComposer: DraftComposerEls | null = null;
  let lastSelectedEl: HTMLElement | null = null;

  function ordinalOf(threadId: string): number {
    const view = threads.find((t) => t.id === threadId);
    // Prefer the engine's stable ordinal so "Edit 2" never becomes "Edit 1"
    // when an earlier thread is removed; index is a legacy fallback.
    if (view?.ordinal !== undefined) return view.ordinal;
    return threads.findIndex((t) => t.id === threadId) + 1;
  }

  /** Resolve a thread's durable anchor to a live element, or null. */
  function resolveElement(view: {
    domPath: string;
    selectorHints: string[];
    tagName: string;
    textPreview: string;
  }): HTMLElement | null {
    if (!view.domPath) return null;
    // Exact structural match first.
    try {
      const exact = document.querySelector(view.domPath);
      if (exact instanceof HTMLElement && exact.hasAttribute('data-finesse-id')) {
        return exact;
      }
    } catch {
      // Invalid selector (rare); fall through to fuzzy matching.
    }
    // Fuzzy fallback: same tag + all selector hints + text preview prefix.
    const tag = view.tagName.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(`${tag}[data-finesse-id]`),
    );
    const wantText = view.textPreview.trim().slice(0, 40);
    let best: HTMLElement | null = null;
    let bestScore = -1;
    for (const el of candidates) {
      let score = 0;
      for (const hint of view.selectorHints) {
        try {
          if (el.matches(hint)) score += 2;
        } catch {
          // ignore malformed hint
        }
      }
      if (wantText && (el.innerText || el.textContent || '').trim().startsWith(wantText)) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    // Require at least one positive signal to avoid arbitrary matches.
    return bestScore > 0 ? best : null;
  }

  function visibleThreads(): EditThreadView[] {
    const path = opts.currentPath();
    return threads.filter((t) => t.path === path);
  }

  /**
   * Reconcile pins and the open composer against the current thread list.
   * Crucially this UPDATES existing DOM in place rather than rebuilding it, so
   * the rapid `agentThreadsState` snapshots streamed during a run never destroy
   * the element the user is clicking or typing into.
   */
  function render(): void {
    const views = visibleThreads();
    const seen = new Set<string>();
    let detachedCount = 0;
    const rects: Array<{
      threadId: string;
      rect: { x: number; y: number; width: number; height: number };
      visible: boolean;
    }> = [];

    for (const view of views) {
      seen.add(view.id);
      const el = view.domPath ? resolveElement(view) : null;
      const ordinal = ordinalOf(view.id);
      const pin = ensurePin(view.id);
      updatePin(pin, view, ordinal, el !== null);

      if (el) {
        const r = el.getBoundingClientRect();
        pin.style.left = `${Math.max(2, r.left - 10)}px`;
        pin.style.top = `${Math.max(2, r.top - 10)}px`;
        pin.style.right = 'auto';
        pin.style.bottom = 'auto';
        rects.push({
          threadId: view.id,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          visible: true,
        });
      } else {
        // Detached: park the pin in a top-right stack so it stays reachable
        // without colliding with the help panel / interact toggle that own
        // the bottom corners. Stack by detached order, not ordinal, so there
        // are no gaps.
        const slot = detachedCount++;
        pin.style.left = 'auto';
        pin.style.right = '12px';
        pin.style.top = `${12 + slot * 30}px`;
        pin.style.bottom = 'auto';
        rects.push({
          threadId: view.id,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          visible: false,
        });
      }
    }

    // Remove pins whose thread vanished.
    for (const [id, pin] of pinEls) {
      if (!seen.has(id)) {
        pin.remove();
        pinEls.delete(id);
      }
    }

    syncComposer(views);
    opts.postToParent({ type: 'threadPinRects', rects });
  }

  function ensurePin(threadId: string): HTMLElement {
    const existing = pinEls.get(threadId);
    if (existing) return existing;
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.id = `finesse-pin-${threadId}`;
    pin.className = 'finesse-pin';
    pin.style.pointerEvents = 'auto';
    const num = document.createElement('span');
    num.className = 'finesse-pin-num';
    pin.appendChild(num);
    const mark = document.createElement('span');
    mark.className = 'finesse-pin-mark';
    pin.appendChild(mark);
    pin.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openThreadId = openThreadId === threadId ? null : threadId;
      render();
    });
    pinEls.set(threadId, pin);
    layer.appendChild(pin);
    return pin;
  }

  function updatePin(
    pin: HTMLElement,
    view: EditThreadView,
    ordinal: number,
    attached: boolean,
  ): void {
    pin.style.setProperty('--pin-color', STATUS_COLORS[view.status]);
    pin.classList.toggle('is-detached', !attached);
    pin.classList.toggle('is-running', view.status === 'running');
    pin.classList.toggle('is-active', activeThreadId === view.id);
    pin.classList.toggle('is-open', openThreadId === view.id);

    const num = pin.querySelector('.finesse-pin-num') as HTMLElement;
    num.textContent = String(ordinal);
    const mark = pin.querySelector('.finesse-pin-mark') as HTMLElement;
    if (view.status === 'running') {
      mark.className = 'finesse-pin-mark finesse-pin-spin';
      mark.textContent = '';
    } else {
      mark.className = 'finesse-pin-mark finesse-pin-badge';
      mark.textContent = STATUS_GLYPHS[view.status];
    }
    pin.title = `${STATUS_LABELS[view.status]} · ${view.tagName}${
      view.textPreview ? ` "${view.textPreview.slice(0, 40)}"` : ''
    }`;
  }

  /** Build the composer once when a thread opens; update it in place after. */
  function syncComposer(views: EditThreadView[]): void {
    const view = openThreadId ? views.find((t) => t.id === openThreadId) : undefined;
    if (!view) {
      composer?.root.remove();
      composer = null;
      return;
    }
    const fresh = !composer || composer.threadId !== view.id;
    if (fresh) {
      composer?.root.remove();
      composer = createComposer(view.id);
      layer.appendChild(composer.root);
    }
    updateComposer(composer!, view);
    // Keep the composer pinned near its element as the page scrolls/resizes.
    // Reposition only when the user isn't typing into it, to avoid yanking the
    // caret/scroll while they edit.
    if (fresh || document.activeElement !== composer!.textarea) {
      const el = view.domPath ? resolveElement(view) : null;
      const anchorRect =
        el?.getBoundingClientRect() ?? pinEls.get(view.id)?.getBoundingClientRect();
      if (anchorRect) positionComposer(composer!.root, anchorRect as DOMRect);
    }
  }

  /** Create the persistent composer shell. Inputs/handlers are created once. */
  function createComposer(threadId: string): ComposerEls {
    const root = document.createElement('div');
    root.id = `finesse-composer-${threadId}`;
    root.className = 'finesse-composer';
    root.style.pointerEvents = 'auto';

    const header = document.createElement('div');
    header.className = 'finesse-composer-head';
    const title = document.createElement('span');
    title.className = 'finesse-composer-title';
    header.appendChild(title);
    const status = document.createElement('span');
    status.className = 'finesse-composer-status';
    header.appendChild(status);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'finesse-composer-x';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      openThreadId = null;
      render();
    });
    header.appendChild(close);
    root.appendChild(header);

    const target = document.createElement('div');
    target.className = 'finesse-composer-target';
    root.appendChild(target);

    const history = document.createElement('div');
    history.className = 'finesse-composer-history';
    root.appendChild(history);

    const error = document.createElement('div');
    error.className = 'finesse-composer-error';
    root.appendChild(error);

    const log = document.createElement('pre');
    log.className = 'finesse-composer-log';
    root.appendChild(log);

    const textarea = document.createElement('textarea');
    textarea.className = 'finesse-composer-input';
    textarea.rows = 2;
    textarea.value = drafts.get(threadId) ?? '';
    textarea.addEventListener('input', () => drafts.set(threadId, textarea.value));
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const view = threads.find((t) => t.id === threadId);
        if (view) submitSteerAndRun(view);
      }
    });
    root.appendChild(textarea);

    const hint = document.createElement('div');
    hint.className = 'finesse-composer-hint';
    root.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'finesse-composer-actions';
    root.appendChild(actions);

    return {
      threadId,
      root,
      title,
      status,
      target,
      history,
      error,
      log,
      textarea,
      hint,
      actions,
      historyKey: -1,
      actionsKey: '',
    };
  }

  /** Update the composer's dynamic parts without recreating inputs/buttons. */
  function updateComposer(c: ComposerEls, view: EditThreadView): void {
    c.title.textContent = `Edit ${ordinalOf(view.id)} · ${view.tagName}`;
    c.status.style.color = STATUS_COLORS[view.status];
    c.status.textContent =
      STATUS_LABELS[view.status] +
      (view.status === 'queued' && view.queuePosition ? ` #${view.queuePosition}` : '');

    c.target.style.display = view.textPreview ? '' : 'none';
    c.target.textContent = view.textPreview ? `"${view.textPreview.slice(0, 80)}"` : '';

    // Instruction trail (initial prompt + steers). Rebuilt only when the
    // count changes so streaming updates never disturb it.
    const prompts = view.prompts ?? [];
    if (c.historyKey !== prompts.length) {
      c.historyKey = prompts.length;
      c.history.innerHTML = '';
      prompts.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'finesse-composer-prompt';
        const tag = document.createElement('span');
        tag.className = 'finesse-composer-prompt-tag';
        tag.textContent = i === 0 ? 'You' : 'Steer';
        row.appendChild(tag);
        const text = document.createElement('span');
        text.textContent = p.text;
        row.appendChild(text);
        c.history.appendChild(row);
      });
    }
    c.history.style.display = prompts.length > 0 ? '' : 'none';

    c.error.style.display = view.error ? '' : 'none';
    c.error.textContent = view.error ?? '';

    if (view.runLogTail) {
      c.log.style.display = '';
      if (c.log.textContent !== view.runLogTail) {
        const atBottom = c.log.scrollHeight - c.log.scrollTop - c.log.clientHeight < 24;
        c.log.textContent = view.runLogTail;
        if (atBottom) c.log.scrollTop = c.log.scrollHeight;
      }
    } else {
      c.log.style.display = 'none';
      c.log.textContent = '';
    }

    const running = view.status === 'running' || view.status === 'queued';
    const placeholder =
      view.status === 'idle'
        ? 'Describe this edit…'
        : running
          ? 'Add steering instructions (applies to the next run)…'
          : 'Refine this edit and re-run…';
    if (c.textarea.placeholder !== placeholder) c.textarea.placeholder = placeholder;

    // Rebuild the action row only when the status changes — never while the
    // user might be mid-click on a stable set of buttons.
    if (c.actionsKey !== view.status) {
      c.actionsKey = view.status;
      c.actions.innerHTML = '';
      const terminal = view.status === 'done';
      const failed = view.status === 'error' || view.status === 'stale';

      if (view.status === 'idle') {
        c.actions.appendChild(actionBtn('Run', 'primary', () => submitSteerAndRun(view)));
      } else if (running) {
        c.actions.appendChild(actionBtn('Steer', 'primary', () => submitSteer(view)));
        c.actions.appendChild(
          actionBtn('Pause', 'ghost', () => sendAction({ kind: 'pause', threadId: view.id })),
        );
      } else if (view.status === 'paused') {
        c.actions.appendChild(
          actionBtn('Resume', 'primary', () => sendAction({ kind: 'resume', threadId: view.id })),
        );
      } else if (terminal) {
        // The agent already wrote the file, so this is housekeeping: "Done"
        // clears the pin and the changes stay. "Re-run" applies any new
        // steering on top.
        c.actions.appendChild(actionBtn('Done', 'primary', () => removeThread(view)));
        c.actions.appendChild(actionBtn('Re-run', 'ghost', () => submitSteerAndRun(view)));
      } else if (failed) {
        c.actions.appendChild(actionBtn('Retry', 'primary', () => submitSteerAndRun(view)));
      }
      if (!terminal) {
        c.actions.appendChild(actionBtn('Remove pin', 'link', () => removeThread(view)));
      }
    }

    // Hint clarifies that clearing the pin keeps the file changes.
    const showHint = view.status === 'done' || view.status === 'error';
    c.hint.style.display = showHint ? '' : 'none';
    c.hint.textContent = showHint
      ? `The file already has these changes — clearing the pin keeps them. Undo with ${modKey('Z')} if needed.`
      : '';
  }

  function removeThread(view: EditThreadView): void {
    drafts.delete(view.id);
    if (openThreadId === view.id) openThreadId = null;
    sendAction({ kind: 'delete', threadId: view.id });
  }

  function submitSteer(view: EditThreadView): void {
    const text = (drafts.get(view.id) ?? '').trim();
    if (!text) return;
    drafts.delete(view.id);
    sendAction({ kind: 'steer', threadId: view.id, prompt: text });
  }

  function submitSteerAndRun(view: EditThreadView): void {
    const text = (drafts.get(view.id) ?? '').trim();
    if (text) {
      drafts.delete(view.id);
      sendAction({ kind: 'steer', threadId: view.id, prompt: text });
    }
    sendAction({ kind: 'run', threadId: view.id });
  }

  function sendAction(payload: ThreadAction): void {
    opts.postToParent({
      type: 'threadActionRequest',
      path: opts.currentPath(),
      payload,
    });
  }

  function applyThreadsState(state: AgentThreadsState): void {
    // Merge: replace threads for this state's path, keep others.
    const others = threads.filter((t) => t.path !== state.path);
    threads = [...others, ...state.threads];
    activeThreadId = state.activeThreadId;
    // Close a composer whose thread vanished.
    if (openThreadId && !threads.some((t) => t.id === openThreadId)) {
      openThreadId = null;
    }
    render();
  }

  function applyRunStatus(status: AgentThreadRunStatus): void {
    // The authoritative log lives in AgentThreadsState (runLogTail); this hook
    // is kept for low-latency UI reactions if needed. Re-render to reflect any
    // transient state the snapshot hasn't delivered yet.
    void status;
  }

  function resolveAnchor(msg: ResolveAnchor): void {
    const el = resolveElement({
      domPath: msg.domPath,
      selectorHints: msg.selectorHints,
      tagName: msg.tagName,
      textPreview: msg.textPreview,
    });
    const selection = el ? opts.session.describeElement(el) : null;
    opts.postToParent({
      type: 'anchorResolved',
      path: opts.currentPath(),
      requestId: msg.requestId,
      selection,
    });
  }

  function focusThread(threadId: string): void {
    const view = threads.find((t) => t.id === threadId);
    if (!view) return;
    openThreadId = threadId;
    const el = view.domPath ? resolveElement(view) : null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    render();
  }

  /** Open a fresh "new edit" composer anchored to a freshly-selected element. */
  function startNewEdit(el: HTMLElement): void {
    const selection = opts.session.describeElement(el);
    if (!selection) return;
    closeDraft();
    lastSelectedEl = el;
    // Opening a new edit takes precedence over any open thread composer.
    openThreadId = null;
    render();

    const draft = createDraftComposer(selection, el);
    draftComposer = draft;
    layer.appendChild(draft.root);
    positionComposer(draft.root, el.getBoundingClientRect());
    queueMicrotask(() => draft.textarea.focus());
  }

  function closeDraft(): void {
    draftComposer?.root.remove();
    draftComposer = null;
  }

  function createDraftComposer(
    selection: ElementSelectionSnapshot,
    el: HTMLElement,
  ): DraftComposerEls {
    const root = document.createElement('div');
    root.id = 'finesse-composer-new';
    root.className = 'finesse-composer';
    root.style.pointerEvents = 'auto';

    const header = document.createElement('div');
    header.className = 'finesse-composer-head';
    const title = document.createElement('span');
    title.className = 'finesse-composer-title';
    title.textContent = `✦ Ask AI · ${selection.tagName}`;
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'finesse-composer-x';
    close.textContent = '×';
    close.title = 'Cancel';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDraft();
    });
    header.appendChild(close);
    root.appendChild(header);

    if (selection.textPreview) {
      const target = document.createElement('div');
      target.className = 'finesse-composer-target';
      target.textContent = `"${selection.textPreview.slice(0, 80)}"`;
      root.appendChild(target);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'finesse-composer-input';
    textarea.rows = 2;
    textarea.placeholder = 'What should change on this element?';
    root.appendChild(textarea);

    const submit = (): void => {
      const prompt = textarea.value.trim();
      if (!prompt) return;
      // Re-describe at submit time so the anchor reflects the latest DOM.
      const fresh = opts.session.describeElement(el) ?? selection;
      sendAction({ kind: 'create', prompt, selection: fresh });
      closeDraft();
    };
    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDraft();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'finesse-composer-actions';
    actions.appendChild(actionBtn(`Start (${SEND_KEY_LABEL})`, 'primary', submit));
    actions.appendChild(actionBtn('Cancel', 'link', () => closeDraft()));
    root.appendChild(actions);

    return { root, textarea };
  }

  const reposition = (): void => {
    render();
    if (draftComposer) {
      // Keep the draft pinned to its element unless the user is typing into it.
      const stillSelected = lastSelectedEl;
      if (stillSelected && document.activeElement !== draftComposer.textarea) {
        positionComposer(draftComposer.root, stillSelected.getBoundingClientRect());
      }
    }
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  return {
    applyThreadsState,
    applyRunStatus,
    resolveAnchor,
    focusThread,
    startNewEdit,
    destroy() {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      closeDraft();
      layer.remove();
    },
  };
}

const STATUS_GLYPHS: Record<EditThreadStatus, string> = {
  idle: '✎',
  queued: '…',
  running: '',
  paused: '❚❚',
  done: '✓',
  error: '!',
  stale: '⚲',
};

function actionBtn(
  label: string,
  variant: 'primary' | 'ghost' | 'link',
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `finesse-act finesse-act-${variant}`;
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** Place the composer near its anchor, flipping to stay within the viewport. */
function positionComposer(pop: HTMLElement, anchor: DOMRect): void {
  const W = 280;
  pop.style.width = `${W}px`;
  // Provisional placement; refine after it's measurable.
  let left = anchor.left;
  left = Math.min(Math.max(8, left), window.innerWidth - W - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, anchor.bottom + 10)}px`;
  queueMicrotask(() => {
    const h = pop.offsetHeight;
    if (anchor.bottom + 10 + h > window.innerHeight - 8) {
      const above = anchor.top - 10 - h;
      pop.style.top = `${above > 8 ? above : Math.max(8, window.innerHeight - h - 8)}px`;
    }
  });
}

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'finesse-thread-pins-css';
  style.textContent = PIN_CSS;
  document.head.appendChild(style);
}

const PIN_CSS = `
#finesse-thread-pins, #finesse-thread-pins * { box-sizing: border-box; }
.finesse-pin {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  min-width: 22px;
  padding: 0 6px 0 5px;
  border: none;
  border-radius: 11px;
  background: var(--pin-color, #1e6fd9);
  color: #fff;
  font: 600 11px/1 var(--finesse-font);
  cursor: pointer;
  box-shadow: var(--finesse-shadow-small);
  transition: transform 90ms ease, box-shadow 90ms ease, opacity 90ms ease;
}
.finesse-pin:hover { transform: scale(1.08); box-shadow: 0 3px 10px rgba(0,0,0,0.34); }
.finesse-pin.is-open { outline: 2px solid #fff; outline-offset: 1px; }
.finesse-pin.is-active { box-shadow: 0 0 0 2px rgba(255,255,255,0.6), 0 2px 8px rgba(0,0,0,0.32); }
.finesse-pin.is-detached { opacity: 0.78; border: 1px dashed rgba(255,255,255,0.7); }
.finesse-pin-num { font-weight: 700; }
.finesse-pin-badge { font-size: 10px; opacity: 0.9; }
.finesse-pin-spin {
  width: 9px; height: 9px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.85);
  border-right-color: transparent;
  animation: finesse-pin-spin 0.8s linear infinite;
}
@keyframes finesse-pin-spin { to { transform: rotate(360deg); } }

/* The composer is a floating card that follows the editor theme via the
 * --finesse-* tokens (forwarded from the webview; see theme.ts). */
.finesse-composer {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  background: var(--finesse-surface);
  color: var(--finesse-surface-fg);
  border: 1px solid var(--finesse-surface-border);
  border-radius: 9px;
  box-shadow: var(--finesse-shadow);
  font: 12.5px/1.45 var(--finesse-font);
}
.finesse-composer-head { display: flex; align-items: center; gap: 8px; }
.finesse-composer-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.finesse-composer-status { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
.finesse-composer-x {
  background: transparent; border: none; color: inherit; font-size: 16px;
  line-height: 1; cursor: pointer; opacity: 0.6; padding: 0 2px;
}
.finesse-composer-x:hover { opacity: 1; }
.finesse-composer-target {
  font: 11px/1.4 var(--finesse-mono);
  color: var(--finesse-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.finesse-composer-history {
  display: flex; flex-direction: column; gap: 3px;
  max-height: 110px; overflow-y: auto;
}
.finesse-composer-prompt {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 12px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word;
}
.finesse-composer-prompt-tag {
  flex: 0 0 auto; min-width: 34px;
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--finesse-muted);
}
.finesse-composer-error {
  font-size: 11.5px; color: var(--finesse-danger);
  background: var(--finesse-danger-bg); border: 1px solid var(--finesse-danger-border);
  border-radius: 5px; padding: 5px 7px; white-space: pre-wrap;
}
.finesse-composer-log {
  margin: 0; max-height: 150px; overflow: auto;
  background: rgba(0,0,0,0.25); border: 1px solid var(--finesse-surface-border);
  border-radius: 5px; padding: 6px 8px;
  font: 11px/1.4 var(--finesse-mono);
  white-space: pre-wrap; word-break: break-word; color: var(--finesse-surface-fg);
}
.finesse-composer-input {
  font: inherit; font-size: 12.5px; color: var(--finesse-input-fg);
  background: var(--finesse-input-bg);
  border: 1px solid var(--finesse-input-border); border-radius: 6px;
  padding: 7px 8px; resize: vertical; min-height: 44px; outline: none;
}
.finesse-composer-input:focus { border-color: var(--finesse-focus); }
.finesse-composer-input::placeholder { color: var(--finesse-placeholder); }
.finesse-composer-hint { font-size: 11px; line-height: 1.4; color: var(--finesse-muted); }
.finesse-composer-actions { display: flex; align-items: center; gap: 7px; }
.finesse-act {
  font: 600 11.5px/1 var(--finesse-font);
  border-radius: 5px; padding: 6px 11px; cursor: pointer; border: none;
}
.finesse-act-primary { background: var(--finesse-accent); color: var(--finesse-accent-fg); }
.finesse-act-primary:hover { background: var(--finesse-accent-hover); }
.finesse-act-ghost { background: transparent; color: inherit; border: 1px solid var(--finesse-surface-border); }
.finesse-act-ghost:hover { background: rgba(128,128,128,0.15); }
/* Pin removal is housekeeping (the file keeps its changes) — keep it quiet. */
.finesse-act-link { background: transparent; color: var(--finesse-muted); padding: 6px 4px; margin-left: auto; }
.finesse-act-link:hover { text-decoration: underline; color: var(--finesse-surface-fg); }
`;
