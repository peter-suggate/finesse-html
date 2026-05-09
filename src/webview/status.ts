export interface StatusState {
  file?: string;
  version?: number;
  port?: number;
  locked?: boolean;
}

let state: StatusState = {};
let elFile: HTMLElement | null = null;
let elVersion: HTMLElement | null = null;
let elPort: HTMLElement | null = null;
let elLocked: HTMLElement | null = null;

export function initStatus(initial: StatusState): void {
  elFile = document.getElementById('status-file');
  elVersion = document.getElementById('status-version');
  elPort = document.getElementById('status-port');
  elLocked = document.getElementById('status-locked');
  updateStatus(initial);
}

export function updateStatus(patch: StatusState): void {
  state = { ...state, ...patch };
  if (elFile && state.file !== undefined) elFile.textContent = state.file;
  if (elVersion && state.version !== undefined) elVersion.textContent = `v${state.version}`;
  if (elPort && state.port !== undefined) elPort.textContent = `:${state.port}`;
  if (elLocked) elLocked.hidden = !state.locked;
}
