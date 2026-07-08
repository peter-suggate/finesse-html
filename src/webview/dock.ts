// Side-pane (dock) layout controller: collapse/expand to an edge rail,
// drag-resize the pane width, and switch between the AI and Design tabs.
// State persists in the webview's vscode.getState so it survives reloads.
// This is pure layout — no host/protocol involvement.

export type DockTab = 'ai' | 'design';

interface DockState {
  collapsed: boolean;
  width: number;
  tab: DockTab;
}

interface VsCodeStateApi {
  setState(state: unknown): void;
  getState(): unknown;
}

const MIN_W = 300;
const MAX_W = 680;
const DEFAULT_W = 400;
const DEFAULT_TAB: DockTab = 'ai';

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_W;
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
}

function readPersisted(vscode: VsCodeStateApi): DockState {
  const raw = vscode.getState();
  const dock =
    raw && typeof raw === 'object' ? (raw as { dock?: Partial<DockState> }).dock : undefined;
  return {
    collapsed: dock?.collapsed === true,
    width: clampWidth(typeof dock?.width === 'number' ? dock.width : DEFAULT_W),
    tab: dock?.tab === 'design' ? 'design' : DEFAULT_TAB,
  };
}

function persist(vscode: VsCodeStateApi, state: DockState): void {
  const raw = vscode.getState();
  const base = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  vscode.setState({
    ...base,
    dock: { collapsed: state.collapsed, width: state.width, tab: state.tab },
  });
}

export interface DockController {
  toggle(): void;
  /** Switch the visible tab. Expands the dock if `reveal` and it's collapsed. */
  setTab(tab: DockTab, opts?: { reveal?: boolean }): void;
  getTab(): DockTab;
  /** Show/hide the small activity dot on a tab's label. */
  setTabBadge(tab: DockTab, on: boolean): void;
}

export function setupDock(vscode: VsCodeStateApi): DockController | null {
  const row = document.getElementById('main-row');
  const collapseBtn = document.getElementById('dock-collapse');
  const rail = document.getElementById('dock-rail');
  const handle = document.getElementById('dock-resize');
  const tabButtons: Record<DockTab, HTMLElement | null> = {
    ai: document.getElementById('dock-tab-ai'),
    design: document.getElementById('dock-tab-design'),
  };
  const panes: Record<DockTab, HTMLElement | null> = {
    ai: document.getElementById('dock-pane-ai'),
    design: document.getElementById('dock-pane-design'),
  };
  if (!row) return null;

  const state = readPersisted(vscode);

  function applyWidth(): void {
    row!.style.setProperty('--dock-w', `${state.width}px`);
  }

  function applyCollapsed(): void {
    if (state.collapsed) row!.setAttribute('data-dock-collapsed', '');
    else row!.removeAttribute('data-dock-collapsed');
  }

  function applyTab(): void {
    for (const tab of ['ai', 'design'] as const) {
      const active = state.tab === tab;
      tabButtons[tab]?.setAttribute('aria-selected', active ? 'true' : 'false');
      panes[tab]?.classList.toggle('is-active', active);
      // Looking at a tab clears its "something happened here" dot.
      if (active) tabButtons[tab]?.classList.remove('has-badge');
    }
  }

  function setCollapsed(next: boolean): void {
    if (state.collapsed === next) return;
    state.collapsed = next;
    applyCollapsed();
    persist(vscode, state);
  }

  function setTab(tab: DockTab, opts?: { reveal?: boolean }): void {
    if (opts?.reveal) setCollapsed(false);
    if (state.tab === tab) {
      applyTab();
      return;
    }
    state.tab = tab;
    applyTab();
    persist(vscode, state);
  }

  applyWidth();
  applyCollapsed();
  applyTab();

  collapseBtn?.addEventListener('click', () => setCollapsed(true));
  tabButtons.ai?.addEventListener('click', () => setTab('ai'));
  tabButtons.design?.addEventListener('click', () => setTab('design'));

  const expand = (): void => setCollapsed(false);
  rail?.addEventListener('click', expand);
  rail?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      expand();
    }
  });

  // Drag-resize. The pane is anchored to the right edge, so a leftward drag
  // (smaller clientX) widens it: width = rowRight - pointerX.
  if (handle) {
    let dragging = false;
    let rowRight = 0;

    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      state.width = clampWidth(rowRight - e.clientX);
      applyWidth();
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      handle.releasePointerCapture?.(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persist(vscode, state);
    };
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      rowRight = row.getBoundingClientRect().right;
      handle.classList.add('is-dragging');
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  }

  return {
    toggle: () => setCollapsed(!state.collapsed),
    setTab,
    getTab: () => state.tab,
    setTabBadge(tab: DockTab, on: boolean): void {
      // Never badge the tab the user is looking at.
      if (on && state.tab === tab && !state.collapsed) return;
      tabButtons[tab]?.classList.toggle('has-badge', on);
    },
  };
}
