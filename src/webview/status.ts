export interface StatusState {
  file?: string;
  version?: number;
  port?: number;
  locked?: boolean;
  isDirty?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  selectedLabel?: string;
  agentRunning?: boolean;
}

export interface StatusActions {
  onSave: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

let state: StatusState = {};
let elRoot: HTMLElement | null = null;
let elFile: HTMLElement | null = null;
let elVersion: HTMLElement | null = null;
let elPort: HTMLElement | null = null;
let elLocked: HTMLElement | null = null;
let elDirty: HTMLElement | null = null;
let elSave: HTMLButtonElement | null = null;
let elDiscard: HTMLButtonElement | null = null;
let elUndo: HTMLButtonElement | null = null;
let elRedo: HTMLButtonElement | null = null;
let elSelection: HTMLElement | null = null;
let elSaveState: HTMLElement | null = null;

export function initStatus(initial: StatusState, actions?: StatusActions): void {
  elRoot = document.getElementById('status');
  elFile = document.getElementById('status-file');
  elVersion = document.getElementById('status-version');
  elPort = document.getElementById('status-port');
  elLocked = document.getElementById('status-locked');
  elDirty = document.getElementById('status-dirty');
  elSave = document.getElementById('status-save') as HTMLButtonElement | null;
  elDiscard = document.getElementById('status-discard') as HTMLButtonElement | null;
  elUndo = document.getElementById('status-undo') as HTMLButtonElement | null;
  elRedo = document.getElementById('status-redo') as HTMLButtonElement | null;
  elSelection = document.getElementById('status-selection');
  elSaveState = document.getElementById('status-save-state');
  if (actions) {
    elSave?.addEventListener('click', () => actions.onSave());
    elDiscard?.addEventListener('click', () => actions.onDiscard());
    elUndo?.addEventListener('click', () => actions.onUndo());
    elRedo?.addEventListener('click', () => actions.onRedo());
  }
  updateStatus(initial);
}

export function updateStatus(patch: StatusState): void {
  state = { ...state, ...patch };
  if (elFile && state.file !== undefined) elFile.textContent = state.file;
  if (elVersion && state.version !== undefined) elVersion.textContent = `v${state.version}`;
  if (elPort && state.port !== undefined) elPort.textContent = `:${state.port}`;
  if (elLocked) elLocked.hidden = !state.locked;
  if (elRoot) elRoot.classList.toggle('is-dirty', !!state.isDirty);
  if (elDirty) elDirty.classList.toggle('is-dirty', !!state.isDirty);
  if (elSaveState) {
    elSaveState.textContent = state.isDirty ? 'Unsaved changes' : 'Saved';
  }
  if (elSave) {
    elSave.disabled = !state.isDirty;
    elSave.textContent = state.isDirty ? 'Save now' : 'Saved';
    elSave.classList.toggle('primary', !!state.isDirty);
    elSave.title = state.isDirty ? 'Save changes to disk (⌘S)' : 'No unsaved changes';
    elSave.setAttribute(
      'aria-label',
      state.isDirty ? 'Save changes to disk' : 'No unsaved changes',
    );
  }
  if (elDiscard) elDiscard.disabled = !state.isDirty;
  if (elUndo) elUndo.disabled = !state.canUndo;
  if (elRedo) elRedo.disabled = !state.canRedo;
  if (elSelection) {
    const label = state.selectedLabel;
    elSelection.textContent = label ? `selected: ${label}` : 'no selection';
    elSelection.hidden = !label;
  }
}
