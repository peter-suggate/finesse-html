/**
 * Inline Ask Agent panel — pinned to the bottom of the side dock.
 *
 * Composer-first layout: the prompt input is the visual anchor. Last run stays
 * visible as a turn above the composer rather than swapping the panel into a
 * separate "run" mode. Provider switching, disconnect, and conversation reset
 * live behind a single overflow menu so the resting state stays uncluttered.
 *
 * States the panel handles:
 *   - disconnected: provider needs a credential we don't yet have.
 *     Shows two provider buttons and an inline key input (collapsed by default).
 *   - idle: connected, no run in flight. Just composer + target chip.
 *   - running / done / error: composer stays present below a turn block
 *     showing the prompt, status, streaming output, and inline actions
 *     (retry on error, dismiss on done).
 *
 * Themed with VS Code CSS variables to match the surrounding chrome.
 */

import type {
  AgentThreadRunStatus,
  EditThreadView,
  ThreadAction,
} from '../../shared/protocol';

export type AgentProviderId = 'cursor' | 'claude-code';
export type AgentConnectionSource = 'secret' | 'environment';

export interface AgentPanelState {
  providerId: AgentProviderId;
  connected: boolean;
  connectionSource?: AgentConnectionSource;
  /** Model id the active provider will use for the next run. */
  model?: string;
  selectedLabel?: string;
  agentRunning: boolean;
  /** Tail of streamed status + output lines from the current/last run. */
  runLog: string;
  /** Last error message from a failed run. Cleared when a new run starts. */
  runError?: string;
  runErrorKind?: 'auth';
}

export interface AgentPanelActions {
  onOpenDashboard: () => void;
  onOpenClaudeDocs: () => void;
  onSaveApiKey: (value: string) => void;
  onForgetApiKey: () => void;
  onConnectProvider: (providerId: AgentProviderId) => void;
  onSelectProvider: (providerId: AgentProviderId) => void;
  onChangeModel: () => void;
  onRunAgent: (prompt: string) => void;
  /** Drive a thread's lifecycle (run/pause/resume/restart/steer/delete/focus). */
  onThreadAction: (action: ThreadAction) => void;
}

export interface AgentPanelController {
  setState(patch: Partial<AgentPanelState>): void;
  appendLog(text: string): void;
  clearLog(): void;
  setError(text: string | undefined, kind?: AgentPanelState['runErrorKind']): void;
  /** Replace the roster of lingering edit threads for the active page. */
  setThreads(threads: EditThreadView[], activeThreadId: string | null): void;
  /** Low-latency per-thread run status (the roster already reflects snapshots). */
  applyThreadRunStatus(status: AgentThreadRunStatus): void;
  destroy(): void;
}

export interface SetupAgentPanelOpts {
  host: HTMLElement;
  actions: AgentPanelActions;
}

const MAX_LOG_CHARS = 4000;

interface ProviderMeta {
  id: AgentProviderId;
  label: string;
  shortLabel: string;
  keyPlaceholder: string;
  dashboardLabel: string;
}

const PROVIDERS: Record<AgentProviderId, ProviderMeta> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent',
    shortLabel: 'Cursor',
    keyPlaceholder: 'crsr_… paste API key',
    dashboardLabel: 'Cursor Dashboard',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    shortLabel: 'Claude',
    keyPlaceholder: 'sk-ant-… paste API key (optional)',
    dashboardLabel: 'Claude Code Docs',
  },
};

export function setupAgentPanel(opts: SetupAgentPanelOpts): AgentPanelController {
  injectCss();

  const root = document.createElement('section');
  root.className = 'ap-root';
  root.setAttribute('aria-label', 'Ask Agent');

  // The conversation area shows the last submitted prompt and the agent's
  // streamed output as stacked turns. It scrolls; the composer stays pinned.
  const conversation = document.createElement('div');
  conversation.className = 'ap-conversation';
  root.appendChild(conversation);

  // The composer block. Rendered in two shapes depending on connection:
  //   - connect card (provider buttons + key input)
  //   - composer (target chip + textarea + send + bottom rail)
  const dock = document.createElement('div');
  dock.className = 'ap-dock';
  root.appendChild(dock);

  let state: AgentPanelState = {
    providerId: 'cursor',
    connected: false,
    agentRunning: false,
    runLog: '',
  };
  let pendingPrompt = '';
  let pendingKey = '';
  // The user's most-recently-submitted prompt. Survives across runs so the
  // turn block can re-render it without us having to plumb it through state.
  let lastSubmittedPrompt = '';
  let showKeyInput = false;
  let menuOpen = false;
  // Lingering edit threads for the active page (roster above the composer).
  let threads: EditThreadView[] = [];
  let activeThreadId: string | null = null;
  let expandedThreadId: string | null = null;
  const threadDrafts = new Map<string, string>();

  function provider(): ProviderMeta {
    return PROVIDERS[state.providerId];
  }

  function render(): void {
    renderConversation();
    renderDock();
    syncRootDataAttrs();
  }

  function syncRootDataAttrs(): void {
    root.dataset.connected = state.connected ? 'true' : 'false';
    root.dataset.running = state.agentRunning ? 'true' : 'false';
    root.dataset.hasTurn =
      lastSubmittedPrompt || state.runError || threads.length > 0 ? 'true' : 'false';
  }

  function renderConversation(): void {
    conversation.innerHTML = '';
    const hasRoster = threads.length > 0;
    const hasTurn = Boolean(lastSubmittedPrompt) || Boolean(state.runError);
    if (!hasRoster && !hasTurn) {
      conversation.style.display = 'none';
      return;
    }
    conversation.style.display = '';

    if (hasRoster) conversation.appendChild(renderRoster());

    // Keep the legacy single-turn block only when there are no threads (so the
    // old one-shot flow still reads naturally); otherwise the roster owns the
    // run history per thread.
    if (!hasRoster) {
      if (lastSubmittedPrompt) {
        conversation.appendChild(renderUserTurn(lastSubmittedPrompt, state.selectedLabel));
      }
      const agentTurn = renderAgentTurn();
      if (agentTurn) conversation.appendChild(agentTurn);
    }
  }

  function renderRoster(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ap-roster';

    const heading = document.createElement('div');
    heading.className = 'ap-roster-head';
    heading.textContent = `Edits (${threads.length})`;
    wrap.appendChild(heading);

    threads.forEach((thread, i) => {
      wrap.appendChild(renderThreadCard(thread, i + 1));
    });
    return wrap;
  }

  function renderThreadCard(thread: EditThreadView, ordinal: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ap-thread';
    card.dataset.status = thread.status;
    if (activeThreadId === thread.id) card.classList.add('is-active');
    const expanded = expandedThreadId === thread.id;

    // Summary row: ordinal dot, target label, status chip.
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'ap-thread-summary';
    summary.addEventListener('click', () => {
      expandedThreadId = expanded ? null : thread.id;
      // Focusing a thread highlights its pin in the preview.
      if (!expanded) opts.actions.onThreadAction({ kind: 'focus', threadId: thread.id });
      render();
    });

    const dot = document.createElement('span');
    dot.className = 'ap-thread-dot';
    dot.textContent = String(ordinal);
    summary.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'ap-thread-label';
    label.textContent =
      `${thread.tagName}` + (thread.textPreview ? ` · ${thread.textPreview.slice(0, 28)}` : '');
    label.title = thread.textPreview || thread.tagName;
    summary.appendChild(label);

    const chip = document.createElement('span');
    chip.className = 'ap-thread-chip';
    chip.dataset.status = thread.status;
    chip.textContent =
      THREAD_STATUS_LABEL[thread.status] +
      (thread.status === 'queued' && thread.queuePosition ? ` #${thread.queuePosition}` : '');
    summary.appendChild(chip);
    card.appendChild(summary);

    if (expanded) card.appendChild(renderThreadBody(thread));
    return card;
  }

  function renderThreadBody(thread: EditThreadView): HTMLElement {
    const body = document.createElement('div');
    body.className = 'ap-thread-body';

    if (thread.error) {
      const err = document.createElement('div');
      err.className = 'ap-thread-error';
      err.textContent = thread.error;
      body.appendChild(err);
    }
    if (thread.runLogTail) {
      const log = document.createElement('pre');
      log.className = 'ap-thread-log';
      log.textContent = thread.runLogTail;
      body.appendChild(log);
      queueMicrotask(() => {
        log.scrollTop = log.scrollHeight;
      });
    }

    const running = thread.status === 'running' || thread.status === 'queued';
    const terminal = thread.status === 'done';
    const failed = thread.status === 'error' || thread.status === 'stale';
    const input = document.createElement('textarea');
    input.className = 'ap-thread-input';
    input.rows = 2;
    input.placeholder =
      thread.status === 'idle'
        ? 'Describe this edit…'
        : running
          ? 'Steer (applies to next run)…'
          : 'Refine this edit and re-run…';
    input.value = threadDrafts.get(thread.id) ?? '';
    input.addEventListener('input', () => threadDrafts.set(thread.id, input.value));
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        steerAndRun(thread);
      }
    });
    body.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'ap-thread-actions';
    if (thread.status === 'idle') {
      actions.appendChild(threadBtn('Run', 'primary', () => steerAndRun(thread)));
    } else if (running) {
      actions.appendChild(threadBtn('Steer', 'primary', () => steer(thread)));
      actions.appendChild(
        threadBtn('Pause', 'ghost', () =>
          opts.actions.onThreadAction({ kind: 'pause', threadId: thread.id }),
        ),
      );
    } else if (thread.status === 'paused') {
      actions.appendChild(
        threadBtn('Resume', 'primary', () =>
          opts.actions.onThreadAction({ kind: 'resume', threadId: thread.id }),
        ),
      );
    } else if (terminal) {
      // The agent already wrote the file. "Accept" clears the pin/card and
      // keeps the changes; "Re-run" applies any new steering on top.
      actions.appendChild(threadBtn('Accept', 'primary', () => removeThread(thread)));
      actions.appendChild(threadBtn('Re-run', 'ghost', () => steerAndRun(thread)));
    } else if (failed) {
      actions.appendChild(threadBtn('Retry', 'primary', () => steerAndRun(thread)));
    }
    actions.appendChild(
      threadBtn(terminal ? 'Discard' : 'Remove', 'link', () => removeThread(thread)),
    );
    body.appendChild(actions);

    if (terminal || failed) {
      const hint = document.createElement('div');
      hint.className = 'ap-thread-hint';
      hint.textContent = 'Accepting keeps the edits in your file. Undo with ⌘Z if needed.';
      body.appendChild(hint);
    }
    return body;
  }

  function removeThread(thread: EditThreadView): void {
    threadDrafts.delete(thread.id);
    if (expandedThreadId === thread.id) expandedThreadId = null;
    opts.actions.onThreadAction({ kind: 'delete', threadId: thread.id });
  }

  function steer(thread: EditThreadView): void {
    const text = (threadDrafts.get(thread.id) ?? '').trim();
    if (!text) return;
    threadDrafts.delete(thread.id);
    opts.actions.onThreadAction({ kind: 'steer', threadId: thread.id, prompt: text });
  }

  function steerAndRun(thread: EditThreadView): void {
    const text = (threadDrafts.get(thread.id) ?? '').trim();
    if (text) {
      threadDrafts.delete(thread.id);
      opts.actions.onThreadAction({ kind: 'steer', threadId: thread.id, prompt: text });
    }
    opts.actions.onThreadAction({ kind: 'run', threadId: thread.id });
  }

  function threadBtn(
    label: string,
    variant: 'primary' | 'ghost' | 'link',
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      variant === 'primary'
        ? 'ap-btn-primary'
        : variant === 'ghost'
          ? 'ap-btn-ghost'
          : 'ap-btn-link';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderUserTurn(prompt: string, target?: string): HTMLElement {
    const turn = document.createElement('div');
    turn.className = 'ap-turn ap-turn-user';
    const meta = document.createElement('div');
    meta.className = 'ap-turn-meta';
    const role = document.createElement('span');
    role.className = 'ap-turn-role';
    role.textContent = 'You';
    meta.appendChild(role);
    if (target) {
      const chip = document.createElement('span');
      chip.className = 'ap-turn-target';
      chip.textContent = target;
      chip.title = `Target: ${target}`;
      meta.appendChild(chip);
    }
    turn.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'ap-turn-body';
    body.textContent = prompt;
    turn.appendChild(body);
    return turn;
  }

  function renderAgentTurn(): HTMLElement | null {
    const hasContent = state.agentRunning || state.runLog || state.runError;
    if (!hasContent) return null;

    const turn = document.createElement('div');
    turn.className = 'ap-turn ap-turn-agent';
    if (state.runError) turn.classList.add('is-error');
    if (state.agentRunning) turn.classList.add('is-running');

    const meta = document.createElement('div');
    meta.className = 'ap-turn-meta';
    const role = document.createElement('span');
    role.className = 'ap-turn-role';
    role.textContent = provider().label;
    meta.appendChild(role);
    const statusBadge = document.createElement('span');
    statusBadge.className = 'ap-turn-status';
    if (state.agentRunning) {
      const dot = document.createElement('span');
      dot.className = 'ap-spinner';
      statusBadge.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = 'thinking';
      statusBadge.appendChild(label);
    } else if (state.runError) {
      statusBadge.textContent = 'failed';
      statusBadge.classList.add('is-error');
    } else {
      statusBadge.textContent = 'done';
    }
    meta.appendChild(statusBadge);
    turn.appendChild(meta);

    if (state.runError) {
      const err = document.createElement('div');
      err.className = 'ap-turn-error';
      err.textContent = state.runError;
      turn.appendChild(err);
    }

    if (state.runLog) {
      const log = document.createElement('pre');
      log.className = 'ap-turn-log';
      log.textContent = state.runLog;
      turn.appendChild(log);
      queueMicrotask(() => {
        log.scrollTop = log.scrollHeight;
        conversation.scrollTop = conversation.scrollHeight;
      });
    }

    // Inline actions for terminal states. Retry on error reuses the same
    // prompt and target; Dismiss clears the turn so the composer is clean.
    if (!state.agentRunning) {
      const actions = document.createElement('div');
      actions.className = 'ap-turn-actions';
      if (state.runErrorKind === 'auth') {
        const connect = document.createElement('button');
        connect.type = 'button';
        connect.className = 'ap-btn-primary';
        connect.textContent =
          state.providerId === 'claude-code' ? 'Re-login' : 'Reconnect';
        connect.addEventListener('click', () => {
          opts.actions.onConnectProvider(state.providerId);
        });
        actions.appendChild(connect);
      }
      if (state.runError && lastSubmittedPrompt) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ap-btn-ghost';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
          const prompt = lastSubmittedPrompt;
          clearLog();
          opts.actions.onRunAgent(prompt);
        });
        actions.appendChild(retry);
      }
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'ap-btn-link';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => {
        lastSubmittedPrompt = '';
        clearLog();
      });
      actions.appendChild(dismiss);
      turn.appendChild(actions);
    }

    return turn;
  }

  function renderDock(): void {
    dock.innerHTML = '';
    if (!state.connected) {
      dock.appendChild(renderConnectCard());
    } else {
      dock.appendChild(renderComposer());
    }
  }

  function renderConnectCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ap-connect';

    const heading = document.createElement('div');
    heading.className = 'ap-connect-heading';
    heading.textContent = 'Connect an agent';
    card.appendChild(heading);

    const sub = document.createElement('div');
    sub.className = 'ap-connect-sub';
    sub.textContent =
      state.providerId === 'claude-code'
        ? 'Claude Code uses your existing CLI login, or paste a key below.'
        : 'Cursor needs an API key to edit your selection.';
    card.appendChild(sub);

    const choices = document.createElement('div');
    choices.className = 'ap-connect-choices';
    for (const id of Object.keys(PROVIDERS) as AgentProviderId[]) {
      const meta = PROVIDERS[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'ap-choice' + (state.providerId === id ? ' is-active' : '');
      btn.textContent = meta.shortLabel;
      btn.setAttribute(
        'aria-pressed',
        state.providerId === id ? 'true' : 'false',
      );
      btn.addEventListener('click', () => {
        if (state.providerId === id) return;
        showKeyInput = false;
        pendingKey = '';
        opts.actions.onSelectProvider(id);
      });
      choices.appendChild(btn);
    }
    card.appendChild(choices);

    if (showKeyInput) {
      const keyRow = document.createElement('div');
      keyRow.className = 'ap-key-row';
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = provider().keyPlaceholder;
      input.className = 'ap-input';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = pendingKey;
      const connectBtn = document.createElement('button');
      connectBtn.type = 'button';
      connectBtn.className = 'ap-btn-primary';
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = input.value.trim().length === 0;
      const submit = () => {
        const value = input.value.trim();
        if (!value) return;
        pendingKey = '';
        showKeyInput = false;
        opts.actions.onSaveApiKey(value);
      };
      input.addEventListener('input', () => {
        pendingKey = input.value;
        connectBtn.disabled = input.value.trim().length === 0;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim().length > 0) {
          e.preventDefault();
          submit();
        }
      });
      connectBtn.addEventListener('click', submit);
      keyRow.appendChild(input);
      keyRow.appendChild(connectBtn);
      card.appendChild(keyRow);
      queueMicrotask(() => input.focus());
    }

    const footer = document.createElement('div');
    footer.className = 'ap-connect-footer';
    const keyToggle = document.createElement('button');
    keyToggle.type = 'button';
    keyToggle.className = 'ap-btn-link';
    keyToggle.textContent = showKeyInput ? 'Hide key input' : 'Paste API key';
    keyToggle.addEventListener('click', () => {
      showKeyInput = !showKeyInput;
      render();
    });
    footer.appendChild(keyToggle);

    const docsLink = document.createElement('button');
    docsLink.type = 'button';
    docsLink.className = 'ap-btn-link';
    docsLink.textContent = provider().dashboardLabel;
    docsLink.addEventListener('click', () => {
      if (state.providerId === 'cursor') opts.actions.onOpenDashboard();
      else opts.actions.onOpenClaudeDocs();
    });
    footer.appendChild(docsLink);
    card.appendChild(footer);

    return card;
  }

  function renderComposer(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ap-composer-wrap';

    // Target chip: pill-shaped pseudo-input that anchors the composer to
    // a concrete selection. Falls back to a "Page" pill so the user always
    // knows what scope a prompt will affect.
    const chip = document.createElement('div');
    chip.className = 'ap-chip';
    if (state.selectedLabel) {
      chip.classList.add('is-element');
      const icon = document.createElement('span');
      icon.className = 'ap-chip-icon';
      icon.textContent = '◎';
      icon.setAttribute('aria-hidden', 'true');
      chip.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'ap-chip-label';
      label.textContent = state.selectedLabel;
      label.title = state.selectedLabel;
      chip.appendChild(label);
    } else {
      chip.classList.add('is-page');
      chip.textContent = 'Page-level prompt — no element selected';
    }
    wrap.appendChild(chip);

    const composer = document.createElement('div');
    composer.className = 'ap-composer';

    const textarea = document.createElement('textarea');
    textarea.className = 'ap-textarea';
    textarea.rows = 2;
    textarea.placeholder = state.selectedLabel
      ? 'Ask the agent to edit this element…'
      : 'Ask the agent to edit this page…';
    textarea.value = pendingPrompt;
    // Execution is serialized by the run queue, so a new prompt while a run is
    // in flight simply enqueues another edit — the composer stays live.
    textarea.disabled = false;

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ap-send';
    send.setAttribute('aria-label', 'Send prompt (⌘↩)');
    send.title = state.agentRunning
      ? 'Queue another edit (⌘↩)'
      : 'Send prompt (⌘↩)';
    send.innerHTML = SEND_ICON;
    send.disabled = textarea.value.trim().length === 0;

    const submit = () => {
      const value = textarea.value.trim();
      if (!value) return;
      lastSubmittedPrompt = value;
      pendingPrompt = '';
      opts.actions.onRunAgent(value);
    };

    textarea.addEventListener('input', () => {
      pendingPrompt = textarea.value;
      send.disabled = textarea.value.trim().length === 0;
      autosize(textarea);
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener('click', submit);

    composer.appendChild(textarea);
    composer.appendChild(send);
    wrap.appendChild(composer);
    queueMicrotask(() => autosize(textarea));

    wrap.appendChild(renderRail());
    return wrap;
  }

  function renderRail(): HTMLElement {
    const rail = document.createElement('div');
    rail.className = 'ap-rail';

    const providerBadge = document.createElement('button');
    providerBadge.type = 'button';
    providerBadge.className = 'ap-rail-provider';
    providerBadge.title = 'Switch agent';
    providerBadge.setAttribute('aria-haspopup', 'menu');
    const dot = document.createElement('span');
    dot.className =
      'ap-rail-dot' +
      (state.agentRunning
        ? ' is-running'
        : state.connected
          ? ' is-on'
          : ' is-off');
    providerBadge.appendChild(dot);
    const providerName = document.createElement('span');
    providerName.textContent = provider().shortLabel;
    providerBadge.appendChild(providerName);
    if (state.model) {
      const model = document.createElement('span');
      model.className = 'ap-rail-model';
      model.textContent = state.model;
      model.title = `Model: ${state.model}`;
      providerBadge.appendChild(model);
    }
    if (state.agentRunning) {
      const tag = document.createElement('span');
      tag.className = 'ap-rail-tag';
      tag.textContent = 'running';
      providerBadge.appendChild(tag);
    }
    providerBadge.addEventListener('click', toggleMenu);
    rail.appendChild(providerBadge);

    const hint = document.createElement('span');
    hint.className = 'ap-rail-hint';
    hint.textContent = '⌘↩';
    rail.appendChild(hint);

    const overflow = document.createElement('button');
    overflow.type = 'button';
    overflow.className = 'ap-rail-overflow';
    overflow.setAttribute('aria-label', 'Agent options');
    overflow.setAttribute('aria-haspopup', 'menu');
    overflow.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    overflow.textContent = '⋯';
    overflow.addEventListener('click', toggleMenu);
    rail.appendChild(overflow);

    if (menuOpen) rail.appendChild(renderMenu());
    return rail;
  }

  function renderMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'ap-menu';
    menu.setAttribute('role', 'menu');

    const otherId: AgentProviderId =
      state.providerId === 'cursor' ? 'claude-code' : 'cursor';
    addMenuItem(menu, `Switch to ${PROVIDERS[otherId].label}`, () => {
      menuOpen = false;
      opts.actions.onSelectProvider(otherId);
    });

    addMenuItem(
      menu,
      state.model ? `Change model (${state.model})…` : 'Change model…',
      () => {
        menuOpen = false;
        render();
        opts.actions.onChangeModel();
      },
    );

    if (state.connected) {
      const disconnectLabel =
        state.providerId === 'claude-code'
          ? 'Forget API key'
          : 'Disconnect Cursor';
      addMenuItem(menu, disconnectLabel, () => {
        menuOpen = false;
        opts.actions.onForgetApiKey();
      });
    }

    const hasTurn = Boolean(lastSubmittedPrompt) || Boolean(state.runLog);
    if (hasTurn && !state.agentRunning) {
      addMenuItem(menu, 'Clear conversation', () => {
        menuOpen = false;
        lastSubmittedPrompt = '';
        clearLog();
      });
    }

    addMenuItem(
      menu,
      state.providerId === 'cursor'
        ? 'Open Cursor Dashboard'
        : 'Open Claude Code Docs',
      () => {
        menuOpen = false;
        if (state.providerId === 'cursor') opts.actions.onOpenDashboard();
        else opts.actions.onOpenClaudeDocs();
      },
    );

    return menu;
  }

  function addMenuItem(
    menu: HTMLElement,
    label: string,
    onClick: () => void,
  ): void {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ap-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', onClick);
    menu.appendChild(item);
  }

  function toggleMenu(): void {
    menuOpen = !menuOpen;
    render();
  }

  function autosize(t: HTMLTextAreaElement): void {
    t.style.height = 'auto';
    const max = 160;
    const next = Math.min(t.scrollHeight, max);
    t.style.height = `${next}px`;
  }

  function setState(patch: Partial<AgentPanelState>): void {
    state = { ...state, ...patch };
    render();
  }

  function appendLog(text: string): void {
    state = {
      ...state,
      runLog: (state.runLog + text).slice(-MAX_LOG_CHARS),
      runError: undefined,
      runErrorKind: undefined,
    };
    render();
  }

  function clearLog(): void {
    state = { ...state, runLog: '', runError: undefined, runErrorKind: undefined };
    render();
  }

  function setError(text: string | undefined, kind?: AgentPanelState['runErrorKind']): void {
    state = { ...state, runError: text, runErrorKind: kind };
    render();
  }

  function setThreads(next: EditThreadView[], nextActiveId: string | null): void {
    threads = next;
    activeThreadId = nextActiveId;
    // Drop drafts/expansion for threads that no longer exist.
    const ids = new Set(next.map((t) => t.id));
    if (expandedThreadId && !ids.has(expandedThreadId)) expandedThreadId = null;
    for (const id of Array.from(threadDrafts.keys())) {
      if (!ids.has(id)) threadDrafts.delete(id);
    }
    render();
  }

  function applyThreadRunStatus(_status: AgentThreadRunStatus): void {
    // The roster renders from AgentThreadsState snapshots (which carry the
    // authoritative runLogTail), so per-status events need no extra handling.
    // Kept as a hook for future low-latency streaming into the open card.
  }

  // Close the overflow menu when clicking anywhere outside the rail. Using
  // capture so we win against the click that opened it on the rail itself.
  const onDocClick = (e: MouseEvent) => {
    if (!menuOpen) return;
    const target = e.target as Node | null;
    if (target && root.contains(target)) {
      const insideMenu = (target as HTMLElement).closest?.('.ap-menu');
      const onTrigger = (target as HTMLElement).closest?.(
        '.ap-rail-overflow, .ap-rail-provider',
      );
      if (insideMenu || onTrigger) return;
    }
    menuOpen = false;
    render();
  };
  document.addEventListener('mousedown', onDocClick, true);

  opts.host.appendChild(root);
  render();

  return {
    setState,
    appendLog,
    clearLog,
    setError,
    setThreads,
    applyThreadRunStatus,
    destroy() {
      document.removeEventListener('mousedown', onDocClick, true);
      root.remove();
    },
  };
}

const THREAD_STATUS_LABEL: Record<EditThreadView['status'], string> = {
  idle: 'Draft',
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  error: 'Failed',
  stale: 'Detached',
};

const SEND_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3"/><path d="M3.5 7.5 8 3l4.5 4.5"/></svg>';

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'ap-css';
  style.textContent = AP_CSS;
  document.head.appendChild(style);
}

const AP_CSS = `
.ap-root {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  max-height: 60%;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
  font-family: var(--vscode-font-family);
  font-size: 12px;
  min-height: 0;
  overflow: hidden;
}

.ap-conversation {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 4px 10px;
}
.ap-conversation::-webkit-scrollbar { width: 8px; }
.ap-conversation::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  border-radius: 4px;
}

/* ---------- Thread roster ---------- */
.ap-roster {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ap-roster-head {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.55;
  padding: 0 2px;
}
.ap-thread {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  border-radius: 6px;
  background: var(--vscode-input-background, rgba(128,128,128,0.06));
  overflow: hidden;
}
.ap-thread.is-active {
  border-color: var(--vscode-focusBorder, #4c8dff);
}
.ap-thread-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.ap-thread-summary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1)); }
.ap-thread-dot {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--vscode-descriptionForeground, #777);
}
.ap-thread[data-status="running"] .ap-thread-dot,
.ap-thread[data-status="idle"]    .ap-thread-dot { background: #2f6fe0; }
.ap-thread[data-status="queued"]  .ap-thread-dot { background: #8a6d1f; }
.ap-thread[data-status="paused"]  .ap-thread-dot { background: #6b7280; }
.ap-thread[data-status="done"]    .ap-thread-dot { background: #2f9e57; }
.ap-thread[data-status="error"]   .ap-thread-dot { background: #d14545; }
.ap-thread[data-status="stale"]   .ap-thread-dot { background: #b9772b; }
.ap-thread-label {
  flex: 1;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-thread-chip {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--vscode-badge-background, rgba(128,128,128,0.2));
  color: var(--vscode-badge-foreground, inherit);
}
.ap-thread-chip[data-status="running"] { background: rgba(47,111,224,0.22); color: #6fa8ff; }
.ap-thread-chip[data-status="done"]    { background: rgba(47,158,87,0.20); color: #5fcf8a; }
.ap-thread-chip[data-status="error"]   { background: rgba(209,69,69,0.20); color: #ff9a9a; }
.ap-thread-chip[data-status="paused"]  { background: rgba(107,114,128,0.25); color: #c0c6d0; }
.ap-thread-chip[data-status="stale"]   { background: rgba(185,119,43,0.22); color: #e0a366; }
.ap-thread-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 8px 8px 8px;
}
.ap-thread-error {
  font-size: 11px;
  color: var(--vscode-errorForeground, #e06c6c);
  background: var(--vscode-inputValidation-errorBackground, rgba(224,108,108,0.08));
  border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(224,108,108,0.4));
  border-radius: 4px;
  padding: 5px 7px;
  white-space: pre-wrap;
}
.ap-thread-log {
  margin: 0;
  max-height: 150px;
  overflow: auto;
  background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.22));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  border-radius: 4px;
  padding: 6px 8px;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ap-thread-input {
  font: inherit;
  font-size: 12px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, rgba(0,0,0,0.06));
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 5px;
  padding: 6px 8px;
  resize: vertical;
  min-height: 40px;
  outline: none;
}
.ap-thread-input:focus { border-color: var(--vscode-focusBorder, #007acc); }
.ap-thread-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.ap-thread-actions .ap-btn-link { margin-left: auto; color: var(--vscode-errorForeground, #e06c6c); }
.ap-thread-hint {
  font-size: 10.5px;
  line-height: 1.4;
  opacity: 0.6;
}

.ap-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ap-turn-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  opacity: 0.7;
}
.ap-turn-role { font-weight: 600; letter-spacing: 0.02em; }
.ap-turn-target {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--vscode-badge-background, rgba(128,128,128,0.18));
  color: var(--vscode-badge-foreground, inherit);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-turn-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.7;
  text-transform: lowercase;
}
.ap-turn-status.is-error {
  color: var(--vscode-errorForeground, #e06c6c);
  opacity: 1;
}
.ap-turn-user .ap-turn-body {
  font-size: 11.5px;
  line-height: 1.45;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-input-background, rgba(128,128,128,0.08));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  white-space: pre-wrap;
  word-wrap: break-word;
}
.ap-turn-error {
  font-size: 11.5px;
  color: var(--vscode-errorForeground, #e06c6c);
  white-space: pre-wrap;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(224,108,108,0.08));
  border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(224,108,108,0.4));
}
.ap-turn-log {
  margin: 0;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.22));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.ap-turn-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}

.ap-spinner {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.4px solid currentColor;
  border-right-color: transparent;
  animation: ap-spin 0.9s linear infinite;
  display: inline-block;
}
@keyframes ap-spin { to { transform: rotate(360deg); } }

.ap-dock {
  flex: 0 0 auto;
  padding: 8px 10px 10px 10px;
  border-top: 1px solid transparent;
}
.ap-root[data-has-turn="true"] .ap-dock {
  border-top-color: var(--vscode-panel-border, rgba(128,128,128,0.18));
}

/* ---------- Composer ---------- */
.ap-composer-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ap-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 10.5px;
  line-height: 1.4;
  background: var(--vscode-badge-background, rgba(128,128,128,0.18));
  color: var(--vscode-badge-foreground, inherit);
}
.ap-chip.is-page {
  background: transparent;
  border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.3));
  color: inherit;
  opacity: 0.65;
}
.ap-chip-icon { font-size: 10px; opacity: 0.8; }
.ap-chip-label {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ap-composer {
  position: relative;
  display: flex;
  align-items: flex-end;
  background: var(--vscode-input-background, rgba(0,0,0,0.06));
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 6px;
  transition: border-color 120ms ease;
}
.ap-composer:focus-within {
  border-color: var(--vscode-focusBorder, #007acc);
}
.ap-textarea {
  flex: 1;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: var(--vscode-input-foreground, inherit);
  background: transparent;
  border: none;
  resize: none;
  padding: 7px 36px 7px 9px;
  min-height: 32px;
  max-height: 160px;
  outline: none;
  overflow-y: auto;
}
.ap-textarea::placeholder {
  color: var(--vscode-input-placeholderForeground, currentColor);
  opacity: 0.55;
}
.ap-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
.ap-send {
  position: absolute;
  right: 5px;
  bottom: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border: none;
  cursor: pointer;
  padding: 0;
  transition: opacity 120ms ease, transform 120ms ease;
}
.ap-send:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.ap-send:disabled {
  opacity: 0.35;
  cursor: default;
}
.ap-send svg { display: block; }

/* ---------- Rail ---------- */
.ap-rail {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px 0 2px;
  font-size: 10.5px;
  opacity: 0.85;
}
.ap-rail-provider {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 10.5px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.75;
}
.ap-rail-provider:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
.ap-rail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground, #888);
}
.ap-rail-dot.is-on { background: var(--vscode-charts-green, #5fb35f); }
.ap-rail-dot.is-off { background: var(--vscode-descriptionForeground, #888); opacity: 0.5; }
.ap-rail-dot.is-running {
  background: var(--vscode-charts-yellow, #d9a83a);
  box-shadow: 0 0 0 0 currentColor;
  animation: ap-pulse 1.4s ease-out infinite;
}
@keyframes ap-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(217,168,58,0.55); }
  100% { box-shadow: 0 0 0 5px rgba(217,168,58,0); }
}
.ap-rail-tag {
  font-size: 9.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
}
.ap-rail-model {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 9.5px;
  opacity: 0.6;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-rail-hint {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.45;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
}
.ap-rail-overflow {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  padding: 0 6px;
  cursor: pointer;
  opacity: 0.7;
  border-radius: 3px;
}
.ap-rail-overflow:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }

/* ---------- Menu ---------- */
.ap-menu {
  position: absolute;
  right: 0;
  bottom: 22px;
  min-width: 180px;
  background: var(--vscode-menu-background, var(--vscode-editor-background));
  color: var(--vscode-menu-foreground, inherit);
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  padding: 3px;
  z-index: 20;
  display: flex;
  flex-direction: column;
}
.ap-menu-item {
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  padding: 5px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.ap-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,0.18)));
  color: var(--vscode-menu-selectionForeground, inherit);
}

/* ---------- Connect ---------- */
.ap-connect {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ap-connect-heading {
  font-size: 12px;
  font-weight: 600;
}
.ap-connect-sub {
  font-size: 11px;
  opacity: 0.7;
  line-height: 1.4;
}
.ap-connect-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.ap-choice {
  font: inherit;
  font-size: 11.5px;
  padding: 6px 8px;
  background: var(--vscode-input-background, transparent);
  color: inherit;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  border-radius: 4px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ap-choice:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
}
.ap-choice.is-active {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border-color: transparent;
}
.ap-key-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ap-key-row .ap-input { flex: 1; }
.ap-connect-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 2px;
}

/* ---------- Shared atoms ---------- */
.ap-input {
  font: inherit;
  font-size: 11.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 3px;
  padding: 4px 7px;
  outline: none;
  min-width: 0;
}
.ap-input:focus { border-color: var(--vscode-focusBorder, #007acc); }

.ap-btn-primary {
  font: inherit;
  font-size: 11px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border: none;
  border-radius: 3px;
  padding: 4px 10px;
  cursor: pointer;
}
.ap-btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.ap-btn-primary:disabled { opacity: 0.5; cursor: default; }

.ap-btn-ghost {
  font: inherit;
  font-size: 11px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  border-radius: 3px;
  padding: 3px 9px;
  cursor: pointer;
}
.ap-btn-ghost:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12));
}

.ap-btn-link {
  font: inherit;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  border: none;
  padding: 0;
  cursor: pointer;
}
.ap-btn-link:hover { text-decoration: underline; }
`;
