/**
 * Inline Ask Agent panel — pinned to the bottom of the side dock.
 *
 * Header: provider toggle (Cursor / Claude Code).
 * Body modes:
 *   - `connect` — provider needs a credential we don't yet have. Inline key
 *     input (Cursor) or subscription-login hint (Claude Code).
 *   - `prompt`  — connected and an element is selected; show prompt textarea.
 *   - `run`     — agent run in flight, finished, or errored; show streaming log.
 *
 * Themed with VS Code CSS variables to match the surrounding chrome.
 */

export type AgentProviderId = 'cursor' | 'claude-code';
export type AgentConnectionSource = 'secret' | 'environment';

export interface AgentPanelState {
  providerId: AgentProviderId;
  connected: boolean;
  connectionSource?: AgentConnectionSource;
  selectedLabel?: string;
  agentRunning: boolean;
  /** Tail of streamed status + output lines from the current/last run. */
  runLog: string;
  /** Last error message from a failed run. Cleared when a new run starts. */
  runError?: string;
}

export interface AgentPanelActions {
  onOpenDashboard: () => void;
  onOpenClaudeDocs: () => void;
  onSaveApiKey: (value: string) => void;
  onForgetApiKey: () => void;
  onSelectProvider: (providerId: AgentProviderId) => void;
  onRunAgent: (prompt: string) => void;
}

export interface AgentPanelController {
  setState(patch: Partial<AgentPanelState>): void;
  appendLog(text: string): void;
  clearLog(): void;
  setError(text: string | undefined): void;
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
  connectHint: string;
  subscriptionHint?: string;
  dashboardLabel: string;
}

const PROVIDERS: Record<AgentProviderId, ProviderMeta> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent',
    shortLabel: 'Cursor',
    keyPlaceholder: 'crsr_… paste API key',
    connectHint: 'Connect Cursor to ask the agent to edit the selected element.',
    dashboardLabel: 'Open Cursor Dashboard',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    shortLabel: 'Claude',
    keyPlaceholder: 'sk-ant-… paste API key (optional)',
    connectHint:
      'Claude Code uses your existing Claude CLI login. Run `claude` then `/login` in a terminal — or paste an ANTHROPIC_API_KEY below.',
    subscriptionHint: 'Subscription auth: run `claude` then `/login` in any terminal.',
    dashboardLabel: 'Open Claude Code Docs',
  },
};

export function setupAgentPanel(opts: SetupAgentPanelOpts): AgentPanelController {
  injectCss();

  const root = document.createElement('section');
  root.className = 'ap-root';
  root.setAttribute('aria-label', 'Ask Agent');

  const header = document.createElement('div');
  header.className = 'ap-header';
  const title = document.createElement('span');
  title.className = 'ap-title';
  title.textContent = 'Ask Agent';
  const providerToggle = document.createElement('div');
  providerToggle.className = 'ap-provider-toggle';
  providerToggle.setAttribute('role', 'tablist');
  providerToggle.setAttribute('aria-label', 'Agent provider');
  const status = document.createElement('span');
  status.className = 'ap-status';
  header.appendChild(title);
  header.appendChild(providerToggle);
  header.appendChild(status);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'ap-body';
  root.appendChild(body);

  let state: AgentPanelState = {
    providerId: 'cursor',
    connected: false,
    agentRunning: false,
    runLog: '',
  };
  let pendingPrompt = '';
  let pendingKey = '';

  function provider(): ProviderMeta {
    return PROVIDERS[state.providerId];
  }

  function render(): void {
    renderProviderToggle();
    body.innerHTML = '';
    if (state.agentRunning || state.runLog || state.runError) {
      renderRun();
      status.textContent = state.agentRunning ? 'running' : state.runError ? 'error' : 'done';
    } else if (!state.connected) {
      renderConnect();
      status.textContent = 'not connected';
    } else {
      renderPrompt();
      status.textContent = describeConnectionStatus();
    }
  }

  function describeConnectionStatus(): string {
    if (state.providerId === 'claude-code') {
      if (state.connectionSource === 'environment') return 'connected · env';
      if (state.connectionSource === 'secret') return 'connected · key';
      return 'connected · subscription';
    }
    return state.connectionSource === 'environment' ? 'connected · env' : 'connected';
  }

  function renderProviderToggle(): void {
    providerToggle.innerHTML = '';
    for (const id of Object.keys(PROVIDERS) as AgentProviderId[]) {
      const meta = PROVIDERS[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ap-provider-pill' + (state.providerId === id ? ' is-active' : '');
      btn.textContent = meta.shortLabel;
      btn.title = meta.label;
      btn.disabled = state.agentRunning;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', state.providerId === id ? 'true' : 'false');
      btn.addEventListener('click', () => {
        if (state.agentRunning) return;
        if (state.providerId === id) return;
        opts.actions.onSelectProvider(id);
      });
      providerToggle.appendChild(btn);
    }
  }

  function renderConnect(): void {
    const meta = provider();
    const hint = document.createElement('p');
    hint.className = 'ap-hint';
    hint.textContent = meta.connectHint;
    body.appendChild(hint);

    const dashRow = document.createElement('div');
    dashRow.className = 'ap-row';
    const dashBtn = document.createElement('button');
    dashBtn.type = 'button';
    dashBtn.className = 'ap-btn-ghost';
    dashBtn.textContent = meta.dashboardLabel;
    dashBtn.addEventListener('click', () => {
      if (meta.id === 'cursor') opts.actions.onOpenDashboard();
      else opts.actions.onOpenClaudeDocs();
    });
    dashRow.appendChild(dashBtn);
    body.appendChild(dashRow);

    const inputRow = document.createElement('div');
    inputRow.className = 'ap-row ap-key-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = meta.keyPlaceholder;
    input.className = 'ap-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = pendingKey;
    input.addEventListener('input', () => {
      pendingKey = input.value;
      connectBtn.disabled = input.value.trim().length === 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim().length > 0) {
        e.preventDefault();
        submitKey();
      }
    });
    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'ap-btn-primary';
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = input.value.trim().length === 0;
    connectBtn.addEventListener('click', submitKey);
    inputRow.appendChild(input);
    inputRow.appendChild(connectBtn);
    body.appendChild(inputRow);

    const sub = document.createElement('p');
    sub.className = 'ap-subhint';
    sub.textContent = meta.subscriptionHint ?? 'Stored in extension secrets, not in this workspace.';
    body.appendChild(sub);

    function submitKey(): void {
      const value = input.value.trim();
      if (!value) return;
      pendingKey = '';
      opts.actions.onSaveApiKey(value);
    }
  }

  function renderPrompt(): void {
    const meta = document.createElement('div');
    meta.className = 'ap-meta';
    const target = state.selectedLabel ?? 'no element selected';
    meta.textContent = `Target: ${target}`;
    body.appendChild(meta);

    if (!state.selectedLabel) {
      const empty = document.createElement('p');
      empty.className = 'ap-hint';
      empty.textContent = 'No element selected. Your prompt will apply to the current page.';
      body.appendChild(empty);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'ap-textarea';
    textarea.rows = 3;
    textarea.placeholder = state.selectedLabel
      ? 'e.g. Make this button more prominent and add a chevron icon.'
      : 'e.g. Improve the visual hierarchy and make the page feel more polished.';
    textarea.value = pendingPrompt;
    textarea.addEventListener('input', () => {
      pendingPrompt = textarea.value;
      sendBtn.disabled = textarea.value.trim().length === 0;
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitPrompt();
      }
    });
    body.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'ap-footer';
    const note = document.createElement('span');
    note.className = 'ap-subhint';
    note.textContent = '⌘↩ to send';
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'ap-link';
    forget.textContent = state.providerId === 'claude-code' ? 'Forget API key' : 'Disconnect';
    forget.addEventListener('click', () => opts.actions.onForgetApiKey());
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'ap-btn-primary';
    sendBtn.textContent = 'Send';
    sendBtn.disabled = textarea.value.trim().length === 0;
    sendBtn.addEventListener('click', submitPrompt);
    footer.appendChild(note);
    footer.appendChild(forget);
    footer.appendChild(sendBtn);
    body.appendChild(footer);

    function submitPrompt(): void {
      const value = textarea.value.trim();
      if (!value) return;
      pendingPrompt = '';
      opts.actions.onRunAgent(value);
    }
  }

  function renderRun(): void {
    const heading = document.createElement('div');
    heading.className = 'ap-meta';
    heading.textContent = state.agentRunning
      ? `${provider().label} running…`
      : state.runError
        ? `${provider().label} failed`
        : `${provider().label} finished`;
    body.appendChild(heading);

    if (state.runError) {
      const err = document.createElement('div');
      err.className = 'ap-error';
      err.textContent = state.runError;
      body.appendChild(err);
    }

    if (state.runLog) {
      const log = document.createElement('pre');
      log.className = 'ap-log';
      log.textContent = state.runLog;
      body.appendChild(log);
      queueMicrotask(() => {
        log.scrollTop = log.scrollHeight;
      });
    }

    const footer = document.createElement('div');
    footer.className = 'ap-footer';
    if (!state.agentRunning) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'ap-btn-ghost';
      dismiss.textContent = 'New prompt';
      dismiss.addEventListener('click', () => clearLog());
      footer.appendChild(dismiss);
    } else {
      const note = document.createElement('span');
      note.className = 'ap-subhint';
      note.textContent = `Streaming output from ${provider().label}…`;
      footer.appendChild(note);
    }
    body.appendChild(footer);
  }

  function setState(patch: Partial<AgentPanelState>): void {
    state = { ...state, ...patch };
    render();
  }

  function appendLog(text: string): void {
    state = { ...state, runLog: (state.runLog + text).slice(-MAX_LOG_CHARS) };
    render();
  }

  function clearLog(): void {
    state = { ...state, runLog: '', runError: undefined };
    render();
  }

  function setError(text: string | undefined): void {
    state = { ...state, runError: text };
    render();
  }

  opts.host.appendChild(root);
  render();

  return {
    setState,
    appendLog,
    clearLog,
    setError,
    destroy() {
      root.remove();
    },
  };
}

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

.ap-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.ap-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: 0.85;
}
.ap-provider-toggle {
  display: inline-flex;
  gap: 2px;
  margin-left: 4px;
  padding: 1px;
  border-radius: 3px;
  background: var(--vscode-input-background, rgba(0,0,0,0.15));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
}
.ap-provider-pill {
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 8px;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  opacity: 0.7;
}
.ap-provider-pill:hover { opacity: 1; }
.ap-provider-pill:disabled {
  cursor: default;
  opacity: 0.45;
}
.ap-provider-pill.is-active {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  opacity: 1;
}
.ap-status {
  margin-left: auto;
  font-size: 10.5px;
  opacity: 0.55;
  font-variant: small-caps;
  letter-spacing: 0.04em;
}

.ap-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 10px 10px 10px;
  min-height: 0;
}
.ap-body::-webkit-scrollbar { width: 8px; }
.ap-body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  border-radius: 4px;
}

.ap-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ap-key-row .ap-input { flex: 1; }
.ap-meta {
  font-size: 11px;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-hint {
  margin: 0;
  font-size: 11.5px;
  opacity: 0.75;
  line-height: 1.45;
}
.ap-subhint {
  margin: 0;
  font-size: 10.5px;
  opacity: 0.55;
  line-height: 1.4;
}

.ap-input {
  font: inherit;
  font-size: 11.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 2px;
  padding: 3px 6px;
  outline: none;
  min-width: 0;
}
.ap-input:focus { border-color: var(--vscode-focusBorder, #007acc); }

.ap-textarea {
  font: inherit;
  font-size: 11.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 2px;
  padding: 5px 7px;
  resize: vertical;
  min-height: 60px;
  outline: none;
}
.ap-textarea:focus { border-color: var(--vscode-focusBorder, #007acc); }
.ap-textarea:disabled { opacity: 0.55; cursor: not-allowed; }

.ap-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ap-footer .ap-subhint { flex: 1; }

.ap-btn-primary {
  font: inherit;
  font-size: 11px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border: none;
  border-radius: 2px;
  padding: 3px 10px;
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
  border-radius: 2px;
  padding: 3px 10px;
  cursor: pointer;
}
.ap-btn-ghost:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
}

.ap-link {
  font: inherit;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  border: none;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}

.ap-error {
  font-size: 11.5px;
  color: var(--vscode-errorForeground, #e06c6c);
  white-space: pre-wrap;
}

.ap-log {
  margin: 0;
  padding: 6px 8px;
  max-height: 220px;
  overflow: auto;
  background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.25));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  white-space: pre-wrap;
}
`;
