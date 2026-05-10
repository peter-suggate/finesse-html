export interface StatusState {
  file?: string;
  version?: number;
  port?: number;
  locked?: boolean;
  isDirty?: boolean;
  autoSave?: boolean;
}

export interface StatusActions {
  onSave: () => void;
  onDiscard: () => void;
  onToggleAutoSave: (next: boolean) => void;
}

let state: StatusState = {};
let elFile: HTMLElement | null = null;
let elVersion: HTMLElement | null = null;
let elPort: HTMLElement | null = null;
let elLocked: HTMLElement | null = null;
let elDirty: HTMLElement | null = null;
let elSave: HTMLButtonElement | null = null;
let elDiscard: HTMLButtonElement | null = null;
let elAutoSave: HTMLInputElement | null = null;

export function initStatus(initial: StatusState, actions?: StatusActions): void {
  elFile = document.getElementById('status-file');
  elVersion = document.getElementById('status-version');
  elPort = document.getElementById('status-port');
  elLocked = document.getElementById('status-locked');
  elDirty = document.getElementById('status-dirty');
  elSave = document.getElementById('status-save') as HTMLButtonElement | null;
  elDiscard = document.getElementById('status-discard') as HTMLButtonElement | null;
  elAutoSave = document.getElementById('status-autosave') as HTMLInputElement | null;
  if (actions) {
    elSave?.addEventListener('click', () => actions.onSave());
    elDiscard?.addEventListener('click', () => actions.onDiscard());
    elAutoSave?.addEventListener('change', () => {
      actions.onToggleAutoSave(!!elAutoSave?.checked);
    });
  }
  updateStatus(initial);
}

export function updateStatus(patch: StatusState): void {
  state = { ...state, ...patch };
  if (elFile && state.file !== undefined) elFile.textContent = state.file;
  if (elVersion && state.version !== undefined) elVersion.textContent = `v${state.version}`;
  if (elPort && state.port !== undefined) elPort.textContent = `:${state.port}`;
  if (elLocked) elLocked.hidden = !state.locked;
  if (elDirty) elDirty.classList.toggle('is-dirty', !!state.isDirty);
  if (elSave) {
    elSave.disabled = !state.isDirty;
    elSave.textContent = state.isDirty ? 'Save' : 'Saved';
  }
  if (elDiscard) elDiscard.disabled = !state.isDirty;
  if (elAutoSave && state.autoSave !== undefined) elAutoSave.checked = state.autoSave;
}
