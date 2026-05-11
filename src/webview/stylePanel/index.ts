/**
 * Right-hand style panel — lives in the webview chrome alongside the status
 * bar. Themed with VS Code CSS variables so it matches the surrounding UI.
 *
 * Data flow:
 *   - The iframe announces selection via {@link ElementSelectionChanged}; the
 *     webview's main script forwards the snapshot here via {@link setSelection}.
 *   - Each section reads from `snapshot.styles` (inline + computed) to
 *     populate its inputs.
 *   - On user input, sections call `commit({ prop: value })`. The controller
 *     merges with the element's last-known inline style, serialises the new
 *     `style="…"` value, and posts a {@link PanelStyleEdit} message into the
 *     iframe via the supplied `sender`. The iframe applies optimistically and
 *     forwards the canonical {@link EditElementAttrs} commit to the host.
 */

import type {
  ElementSelectionSnapshot,
  PanelCssEdit,
  PanelSelectElement,
  PanelStyleEdit,
} from '../../shared/protocol';
import {
  attrsForStyleMap,
  parseStyleAttr,
  serialiseStyleAttr,
  withProperties,
  type StyleMap,
} from './styleState';
import {
  backgroundSection,
  borderSection,
  flexSection,
  gridSection,
  layoutSection,
  spacingSection,
  type SectionHandle,
} from './sections';
import {
  classesSection,
  classRuleSections,
  type ClassRuleCommitFn,
  type ClassRuleSectionsHandle,
  type ClassesSectionHandle,
} from './classesPanel';
import { breadcrumbsBar, type BreadcrumbsHandle } from './breadcrumbsPanel';

export interface StylePanelSender {
  /** Post a chrome→iframe message into the iframe. */
  toIframe(msg: PanelStyleEdit | PanelCssEdit | PanelSelectElement): void;
}

export interface SetupSidePanelOpts {
  host: HTMLElement;
  sender: StylePanelSender;
}

export interface SidePanelController {
  setSelection(selection: ElementSelectionSnapshot | null): void;
  setLocked(locked: boolean): void;
  destroy(): void;
}

export function setupSidePanel(opts: SetupSidePanelOpts): SidePanelController {
  const { host, sender } = opts;

  const root = document.createElement('aside');
  root.className = 'sp-root';
  root.setAttribute('aria-label', 'Element styles');

  // Header with tag badge + close button.
  const header = document.createElement('div');
  header.className = 'sp-header';
  const tagBadge = document.createElement('span');
  tagBadge.className = 'sp-tag';
  tagBadge.textContent = '—';
  const meta = document.createElement('span');
  meta.className = 'sp-meta';
  meta.textContent = 'No selection';
  header.appendChild(tagBadge);
  header.appendChild(meta);
  root.appendChild(header);

  const lockedNote = document.createElement('div');
  lockedNote.className = 'sp-locked';
  lockedNote.textContent = 'Editing locked (templated file)';
  lockedNote.hidden = true;
  root.appendChild(lockedNote);

  const breadcrumbs: BreadcrumbsHandle = breadcrumbsBar((elementId) => {
    sender.toIframe({ type: 'panelSelectElement', elementId });
  });
  breadcrumbs.root.hidden = true;
  root.appendChild(breadcrumbs.root);

  const body = document.createElement('div');
  body.className = 'sp-body';
  root.appendChild(body);

  const empty = document.createElement('div');
  empty.className = 'sp-empty';
  empty.innerHTML = 'Click an element in the preview<br>to edit its style.';

  let currentSelection: ElementSelectionSnapshot | null = null;
  let locked = false;
  let suppressCommit = false;
  /** Tracks the inline style as edited locally so multi-prop edits stack. */
  let workingMap: StyleMap = new Map();

  function commit(props: Record<string, string | null>): void {
    if (suppressCommit || !currentSelection || locked) return;
    const before = workingMap;
    const after = withProperties(before, props);
    if (mapsEqual(before, after)) return;
    workingMap = after;
    sender.toIframe({
      type: 'panelStyleEdit',
      documentVersion: currentSelection.documentVersion,
      elementId: currentSelection.elementId,
      attrs: attrsForStyleMap(after),
    });
    // Re-sync sections that may depend on each other (display flips Flex/Grid relevance).
    syncSections(after);
  }

  /**
   * Commit a single attribute mutation (not the inline `style` map). Used by
   * the Classes section to write the element's `class` attribute directly,
   * bypassing the inline-style serialiser that `commit` runs through.
   */
  function commitAttr(attrs: Record<string, string | null>): void {
    if (!currentSelection || locked) return;
    sender.toIframe({
      type: 'panelStyleEdit',
      documentVersion: currentSelection.documentVersion,
      elementId: currentSelection.elementId,
      attrs,
    });
  }

  const classes: ClassesSectionHandle = classesSection(commitAttr);
  body.appendChild(classes.root);

  const sections: SectionHandle[] = [
    layoutSection(commit),
    spacingSection(commit),
    borderSection(commit),
    backgroundSection(commit),
    flexSection(commit),
    gridSection(commit),
  ];
  for (const s of sections) body.appendChild(s.root);

  const commitCssDeclaration: ClassRuleCommitFn = (selector, property, value) => {
    if (!currentSelection || locked) return;
    sender.toIframe({
      type: 'panelCssEdit',
      documentVersion: currentSelection.documentVersion,
      selector,
      property,
      value,
    });
  };
  const classRules: ClassRuleSectionsHandle = classRuleSections(commitCssDeclaration);
  body.appendChild(classRules.root);

  body.appendChild(empty);

  function syncSections(localOverride?: StyleMap): void {
    if (!currentSelection) {
      empty.hidden = false;
      classes.root.style.display = 'none';
      classRules.root.style.display = 'none';
      for (const s of sections) s.root.style.display = 'none';
      tagBadge.textContent = '—';
      meta.textContent = locked ? 'Locked' : 'No selection';
      return;
    }
    empty.hidden = true;
    classes.root.style.display = '';
    classRules.root.style.display = '';
    const styles = currentSelection.styles;
    const computedDisplay = styles.computed.display;
    // If we have local overrides (mid-edit), prefer them over the snapshot's
    // computed display when deciding flex/grid relevance.
    const effectiveDisplay = localOverride?.get('display') ?? computedDisplay;
    const isFlex = effectiveDisplay === 'flex' || effectiveDisplay === 'inline-flex';
    const isGrid = effectiveDisplay === 'grid' || effectiveDisplay === 'inline-grid';

    suppressCommit = true;
    try {
      for (const s of sections) {
        s.root.style.display = '';
        s.sync(styles);
      }
    } finally {
      suppressCommit = false;
    }

    sections.forEach((s, i) => {
      if (s.setRelevant) {
        if (i === 4) s.setRelevant(isFlex);
        else if (i === 5) s.setRelevant(isGrid);
      }
    });

    tagBadge.textContent = currentSelection.tagName;
    meta.textContent = describeSelection(currentSelection);
  }

  function setSelection(selection: ElementSelectionSnapshot | null): void {
    currentSelection = selection;
    workingMap = parseStyleAttr(selection?.styles.inlineStyle ?? null);
    if (selection) {
      classes.sync(selection.classList, selection.classCatalog);
      classRules.sync(selection.classList, selection.classRules);
    }
    breadcrumbs.sync(selection);
    syncSections();
  }

  function setLocked(value: boolean): void {
    locked = value;
    lockedNote.hidden = !locked;
    syncSections();
  }

  host.appendChild(root);
  injectCss();

  return {
    setSelection,
    setLocked,
    destroy() {
      root.remove();
    },
  };
}

function mapsEqual(a: StyleMap, b: StyleMap): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a.entries()) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function describeSelection(s: ElementSelectionSnapshot): string {
  const hints = s.selectorHints.slice(0, 2).join('');
  if (hints) return hints;
  if (s.textPreview) return `“${s.textPreview.slice(0, 40)}”`;
  return ' ';
}

// Re-export pure helpers (handy for tests / callers).
export { parseStyleAttr, serialiseStyleAttr, withProperties };

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'sp-css';
  style.textContent = SP_CSS;
  document.head.appendChild(style);
}

const SP_CSS = `
.sp-root {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}

.sp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
  background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.sp-tag {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  background: var(--vscode-badge-background, rgba(76, 182, 255, 0.14));
  padding: 1px 6px;
  border-radius: 3px;
}
.sp-meta {
  flex: 1;
  font-size: 11px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.sp-body::-webkit-scrollbar { width: 8px; }
.sp-body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  border-radius: 4px;
}
.sp-body::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.55));
}

.sp-section {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
}
.sp-section:last-of-type { border-bottom: none; }

.sp-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: 0.8;
  list-style: none;
}
.sp-summary::-webkit-details-marker { display: none; }
.sp-summary::before {
  content: '';
  width: 0;
  height: 0;
  border-left: 4px solid currentColor;
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
  margin-right: 2px;
  opacity: 0.6;
  transition: transform 100ms ease-out;
}
.sp-section[open] > .sp-summary::before { transform: rotate(90deg) translateX(1px); }
.sp-summary:hover { opacity: 1; }

.sp-content {
  padding: 6px 10px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sp-row {
  display: grid;
  grid-template-columns: 50px 1fr;
  align-items: center;
  gap: 6px;
}
.sp-row > label {
  font-size: 11px;
  opacity: 0.7;
}

.sp-rowctl {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.sp-input {
  font: inherit;
  font-size: 11.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 2px;
  padding: 2px 6px;
  width: 100%;
  min-width: 0;
  outline: none;
}
.sp-input:focus {
  border-color: var(--vscode-focusBorder, #007acc);
}

.sp-num {
  width: 60px;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.sp-unit {
  appearance: none;
  font: inherit;
  font-size: 10.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 2px;
  padding: 1px 14px 1px 4px;
  cursor: pointer;
  height: 22px;
  flex: 0 0 auto;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'><path fill='gray' d='M1 3l3 3 3-3z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 2px center;
}

.sp-select {
  appearance: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 2px;
  padding: 2px 22px 2px 6px;
  cursor: pointer;
  width: 100%;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='gray' d='M2 4l3 3 3-3z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 6px center;
}

.sp-color {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.sp-swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
  background-image:
    linear-gradient(45deg, rgba(128,128,128,0.18) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128,128,128,0.18) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.18) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.18) 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  position: relative;
  overflow: hidden;
  cursor: pointer;
  flex: 0 0 auto;
}
.sp-swatch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.sp-swatch::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--sp-sw-color, transparent);
  border-radius: 2px;
}

.sp-segment {
  display: inline-flex;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
  border-radius: 3px;
  padding: 1px;
  flex: 1;
  min-width: 0;
}
.sp-segbtn {
  appearance: none;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 2px;
  cursor: pointer;
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  opacity: 0.6;
}
.sp-segbtn[aria-pressed="true"] {
  background: var(--vscode-toolbar-activeBackground, rgba(76, 182, 255, 0.16));
  color: var(--vscode-textLink-foreground, #4cb6ff);
  opacity: 1;
}
.sp-segbtn:hover:not([aria-pressed="true"]) {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
  opacity: 1;
}

.sp-box {
  position: relative;
  background: transparent;
  border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
  border-radius: 4px;
  padding: 22px 26px;
  margin: 4px 0;
}
.sp-box-inner {
  background: var(--vscode-editorWidget-background, rgba(76, 182, 255, 0.06));
  border: 1px solid var(--vscode-panel-border, rgba(76, 182, 255, 0.18));
  border-radius: 3px;
  padding: 18px 22px;
  text-align: center;
  font-size: 10px;
  opacity: 0.65;
  letter-spacing: 0.04em;
}
.sp-box-side {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sp-box-side.top { top: 1px; left: 50%; transform: translateX(-50%); }
.sp-box-side.bottom { bottom: 1px; left: 50%; transform: translateX(-50%); }
.sp-box-side.left { left: 2px; top: 50%; transform: translateY(-50%); }
.sp-box-side.right { right: 2px; top: 50%; transform: translateY(-50%); }
.sp-box-input {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 2px;
  color: inherit;
  font: inherit;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  width: 28px;
  text-align: center;
  padding: 1px 2px;
  outline: none;
}
.sp-box-input:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
.sp-box-input:focus { background: var(--vscode-input-background, rgba(76, 182, 255, 0.1)); border-color: var(--vscode-focusBorder, #007acc); }
.sp-box-label {
  position: absolute;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.5;
}
.sp-box-label.outer { top: 4px; left: 8px; }
.sp-box-label.inner { top: 4px; left: 8px; opacity: 0.5; }

.sp-empty {
  padding: 24px 16px;
  font-size: 11.5px;
  text-align: center;
  line-height: 1.5;
  opacity: 0.55;
}

.sp-locked {
  padding: 6px 10px;
  font-size: 10.5px;
  text-align: center;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.06));
  color: var(--vscode-inputValidation-warningForeground, inherit);
  opacity: 0.85;
}

.sp-breadcrumbs {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  padding: 4px 8px;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
}
.sp-breadcrumbs::-webkit-scrollbar { height: 4px; }
.sp-breadcrumbs::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  border-radius: 2px;
}
.sp-breadcrumbs-list {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.sp-crumb {
  appearance: none;
  background: transparent;
  border: none;
  padding: 1px 4px;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10.5px;
  color: var(--vscode-foreground, inherit);
  opacity: 0.62;
  cursor: pointer;
  border-radius: 2px;
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
button.sp-crumb:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
  color: var(--vscode-textLink-foreground, #4cb6ff);
}
.sp-crumb-leaf {
  opacity: 1;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  font-weight: 600;
  cursor: default;
}
.sp-crumb-sep {
  font-size: 10px;
  opacity: 0.4;
  padding: 0 1px;
  pointer-events: none;
}

.sp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 22px;
}
.sp-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 2px 1px 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  background: var(--vscode-badge-background, rgba(76, 182, 255, 0.14));
  border: 1px solid var(--vscode-input-border, rgba(76, 182, 255, 0.25));
  border-radius: 10px;
  max-width: 100%;
  min-width: 0;
}
.sp-chip-label {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-chip-remove {
  appearance: none;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 0 4px;
  opacity: 0.6;
  border-radius: 50%;
}
.sp-chip-remove:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.sp-chips-empty {
  font-size: 11px;
  opacity: 0.45;
  font-style: italic;
}
.sp-class-add {
  margin-top: 2px;
  position: relative;
}
.sp-class-input {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11.5px;
}
.sp-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 2px);
  z-index: 20;
  max-height: 200px;
  overflow-y: auto;
  background: var(--vscode-quickInput-background, var(--vscode-editor-background, #1e1e1e));
  color: var(--vscode-quickInput-foreground, var(--vscode-foreground, inherit));
  border: 1px solid var(--vscode-focusBorder, var(--vscode-input-border, rgba(128,128,128,0.4)));
  border-radius: 3px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}
.sp-dropdown::-webkit-scrollbar { width: 8px; }
.sp-dropdown::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
  border-radius: 4px;
}
.sp-dropdown::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.55));
}
.sp-dropdown-item {
  padding: 3px 8px;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-dropdown-item[data-active="true"] {
  background: var(--vscode-list-activeSelectionBackground, rgba(76, 182, 255, 0.18));
  color: var(--vscode-list-activeSelectionForeground, inherit);
}

.sp-classrules { display: block; }
.sp-classrule-summary {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sp-classrule-title {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  color: var(--vscode-textLink-foreground, #4cb6ff);
  text-transform: none;
  letter-spacing: 0;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-classrule-count {
  font-size: 10px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
.sp-classrule-content {
  gap: 4px;
}
.sp-classrule-selector {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground, inherit);
  opacity: 0.82;
  padding: 2px 0 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-classrule-selector:not(:first-child) {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
}
.sp-classrule-empty {
  font-size: 11px;
  opacity: 0.55;
  font-style: italic;
  padding: 2px 0;
}
.sp-decl-row {
  display: grid;
  grid-template-columns: 90px 1fr 18px;
  align-items: center;
  gap: 6px;
}
.sp-decl-prop {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
  opacity: 0.78;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-decl-value {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
}
.sp-decl-remove {
  appearance: none;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  opacity: 0.45;
  border-radius: 50%;
  width: 18px;
  height: 18px;
}
.sp-decl-remove:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.sp-decl-add {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 6px;
  margin-top: 2px;
  padding-top: 4px;
  border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.18));
}
.sp-decl-add-prop,
.sp-decl-add-value {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace);
  font-size: 11px;
}
.sp-decl-add-prop::placeholder,
.sp-decl-add-value::placeholder {
  opacity: 0.4;
}
`;
