/**
 * Inline Ask Agent panel — pinned to the bottom of the side dock.
 *
 * One panel, three modes:
 *   - `connect` — no API key stored. Inline key input + dashboard link.
 *   - `prompt`  — connected and an element is selected; show prompt textarea.
 *   - `run`     — agent run in flight, finished, or errored; show streaming log.
 *
 * Themed with VS Code CSS variables to match the surrounding chrome.
 */

export type AgentConnectionSource = 'secret' | 'environment';

export interface AgentPanelState {
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
  onSaveApiKey: (value: string) => void;
  onForgetApiKey: () => void;
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
  const status = document.createElement('span');
  status.className = 'ap-status';
  header.appendChild(title);
  header.appendChild(status);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'ap-body';
  root.appendChild(body);

  let state: AgentPanelState = {
    connected: false,
    agentRunning: false,
    runLog: '',
  };
  let pendingPrompt = '';
  let pendingKey = '';

  function render(): void {
    body.innerHTML = '';
    if (state.agentRunning || state.runLog || state.runError) {
      renderRun();
      status.textContent = state.agentRunning ? 'running' : state.runError ? 'error' : 'done';
    } else if (!state.connected) {
      renderConnect();
      status.textContent = 'not connected';
    } else {
      renderPrompt();
      status.textContent = state.connectionSource === 'environment' ? 'connected · env' : 'connected';
    }
  }

  function renderConnect(): void {
    const hint = document.createElement('p');
    hint.className = 'ap-hint';
    hint.textContent = 'Connect Cursor to ask the agent to edit the selected element.';
    body.appendChild(hint);

    const dashRow = document.createElement('div');
    dashRow.className = 'ap-row';
    const dashBtn = document.createElement('button');
    dashBtn.type = 'button';
    dashBtn.className = 'ap-btn-ghost';
    dashBtn.textContent = 'Open Cursor Dashboard';
    dashBtn.addEventListener('click', () => opts.actions.onOpenDashboard());
    dashRow.appendChild(dashBtn);
    body.appendChild(dashRow);

    const inputRow = document.createElement('div');
    inputRow.className = 'ap-row ap-key-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'crsr_… paste API key';
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
    sub.textContent = 'Stored in extension secrets, not in the workspace.';
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
      empty.textContent = 'Click an element in the preview, then write your prompt below.';
      body.appendChild(empty);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'ap-textarea';
    textarea.rows = 3;
    textarea.placeholder = 'e.g. Make this button more prominent and add a chevron icon.';
    textarea.value = pendingPrompt;
    textarea.disabled = !state.selectedLabel;
    textarea.addEventListener('input', () => {
      pendingPrompt = textarea.value;
      sendBtn.disabled = textarea.value.trim().length === 0 || !state.selectedLabel;
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
    forget.textContent = 'Disconnect';
    forget.addEventListener('click', () => opts.actions.onForgetApiKey());
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'ap-btn-primary';
    sendBtn.textContent = 'Send';
    sendBtn.disabled = textarea.value.trim().length === 0 || !state.selectedLabel;
    sendBtn.addEventListener('click', submitPrompt);
    footer.appendChild(note);
    footer.appendChild(forget);
    footer.appendChild(sendBtn);
    body.appendChild(footer);

    function submitPrompt(): void {
      const value = textarea.value.trim();
      if (!value || !state.selectedLabel) return;
      pendingPrompt = '';
      opts.actions.onRunAgent(value);
    }
  }

  function renderRun(): void {
    const heading = document.createElement('div');
    heading.className = 'ap-meta';
    heading.textContent = state.agentRunning
      ? 'Agent running…'
      : state.runError
        ? 'Agent failed'
        : 'Agent finished';
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
      note.textContent = 'Streaming output from Cursor Agent…';
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
