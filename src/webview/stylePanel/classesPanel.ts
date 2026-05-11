/**
 * "Classes" section for the side panel — lists the selected element's
 * `class` tokens as removable chips and offers a themed autocomplete input
 * limited to classes already used elsewhere in the document. Emits a single
 * `class` attribute commit per edit through the shared commit channel.
 *
 * Also exposes {@link classRuleSections} — one `<details>` per applied class,
 * rendering the declarations defined by that class's CSS rule with editable
 * value inputs. Edits flow through a {@link ClassRuleCommitFn} which the
 * caller routes to the iframe as a `panelCssEdit` message.
 */

import type { ClassRuleBlock, ClassRuleDeclaration } from '../../shared/protocol';
import { bumpCssValue, bumpStep } from './bumpCssValue';
import type { CommitFn } from './sections';

export type ClassRuleCommitFn = (
  selector: string,
  property: string,
  value: string | null,
) => void;

export interface ClassRuleSectionsHandle {
  root: HTMLElement;
  sync(
    classList: string[],
    classRules: Record<string, ClassRuleBlock[]>,
  ): void;
}

export interface ClassesSectionHandle {
  root: HTMLDetailsElement;
  sync(classList: string[], catalog: string[]): void;
}

export function classesSection(commit: CommitFn): ClassesSectionHandle {
  const root = document.createElement('details');
  root.className = 'sp-section sp-classes';
  root.open = true;
  const summary = document.createElement('summary');
  summary.className = 'sp-summary';
  summary.textContent = 'Classes';
  root.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'sp-content';
  root.appendChild(content);

  const chipStrip = document.createElement('div');
  chipStrip.className = 'sp-chips';
  content.appendChild(chipStrip);

  const addRow = document.createElement('div');
  addRow.className = 'sp-class-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sp-input sp-class-input';
  input.placeholder = 'Add class…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  addRow.appendChild(input);

  const dropdown = document.createElement('div');
  dropdown.className = 'sp-dropdown';
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;
  addRow.appendChild(dropdown);
  content.appendChild(addRow);

  const empty = document.createElement('div');
  empty.className = 'sp-chips-empty';
  empty.textContent = 'No classes';
  chipStrip.appendChild(empty);

  let current: string[] = [];
  let catalog: string[] = [];
  let suggestions: string[] = [];
  let highlightedIndex = -1;
  let suppressOpen = false;

  function commitTokens(next: string[]): void {
    const value = next.join(' ').trim();
    commit({ class: value.length > 0 ? value : null });
    current = next;
    render();
  }

  function addToken(raw: string): void {
    const tok = raw.trim();
    if (!tok) return;
    const tokens = tok.split(/\s+/).filter(Boolean);
    const seen = new Set(current);
    const next = current.slice();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      next.push(t);
    }
    if (next.length === current.length) return;
    commitTokens(next);
  }

  function removeToken(token: string): void {
    const next = current.filter((t) => t !== token);
    if (next.length === current.length) return;
    commitTokens(next);
  }

  function render(): void {
    chipStrip.textContent = '';
    if (current.length === 0) {
      chipStrip.appendChild(empty);
    } else {
      for (const cls of current) {
        chipStrip.appendChild(makeChip(cls, removeToken));
      }
    }
  }

  function computeSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const applied = new Set(current);
    const pool = catalog.filter((c) => !applied.has(c));
    if (!q) return pool;
    return pool.filter((c) => c.toLowerCase().includes(q));
  }

  function renderDropdown(): void {
    dropdown.textContent = '';
    if (suggestions.length === 0) {
      dropdown.hidden = true;
      return;
    }
    suggestions.forEach((cls, i) => {
      const opt = document.createElement('div');
      opt.className = 'sp-dropdown-item';
      opt.setAttribute('role', 'option');
      opt.textContent = cls;
      if (i === highlightedIndex) opt.dataset.active = 'true';
      // Use mousedown (fires before input's blur) so we don't lose the click.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = '';
        suppressOpen = true;
        closeDropdown();
        addToken(cls);
        // Re-enable opening on next user gesture.
        setTimeout(() => {
          suppressOpen = false;
        }, 0);
      });
      opt.addEventListener('mousemove', () => {
        if (highlightedIndex !== i) {
          highlightedIndex = i;
          updateHighlight();
        }
      });
      dropdown.appendChild(opt);
    });
    dropdown.hidden = false;
  }

  function updateHighlight(): void {
    const items = dropdown.querySelectorAll<HTMLElement>('.sp-dropdown-item');
    items.forEach((el, i) => {
      if (i === highlightedIndex) {
        el.dataset.active = 'true';
        el.scrollIntoView({ block: 'nearest' });
      } else {
        delete el.dataset.active;
      }
    });
  }

  function openDropdown(): void {
    if (suppressOpen) return;
    suggestions = computeSuggestions(input.value);
    highlightedIndex = suggestions.length > 0 ? 0 : -1;
    renderDropdown();
  }

  function closeDropdown(): void {
    suggestions = [];
    highlightedIndex = -1;
    dropdown.hidden = true;
    dropdown.textContent = '';
  }

  input.addEventListener('input', openDropdown);
  input.addEventListener('focus', openDropdown);
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      const v = input.value;
      input.value = '';
      addToken(v);
    }
    closeDropdown();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (dropdown.hidden) {
        openDropdown();
        return;
      }
      if (suggestions.length === 0) return;
      highlightedIndex = (highlightedIndex + 1) % suggestions.length;
      updateHighlight();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      highlightedIndex =
        (highlightedIndex - 1 + suggestions.length) % suggestions.length;
      updateHighlight();
      return;
    }
    if (e.key === 'Escape') {
      if (!dropdown.hidden) {
        e.preventDefault();
        closeDropdown();
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!dropdown.hidden && highlightedIndex >= 0) {
        const pick = suggestions[highlightedIndex];
        input.value = '';
        closeDropdown();
        addToken(pick);
      } else {
        const v = input.value;
        input.value = '';
        closeDropdown();
        addToken(v);
      }
      return;
    }
    if (e.key === ',' || (e.key === ' ' && input.value.trim())) {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      closeDropdown();
      addToken(v);
      return;
    }
    if (e.key === 'Backspace' && input.value === '' && current.length > 0) {
      removeToken(current[current.length - 1]);
    }
  });

  function sync(classList: string[], nextCatalog: string[]): void {
    current = classList.slice();
    catalog = nextCatalog;
    render();
    if (document.activeElement === input) openDropdown();
  }

  render();

  return { root, sync };
}

export function classRuleSections(commit: ClassRuleCommitFn): ClassRuleSectionsHandle {
  const root = document.createElement('div');
  root.className = 'sp-classrules';

  function sync(
    classList: string[],
    classRules: Record<string, ClassRuleBlock[]>,
  ): void {
    root.textContent = '';
    for (const cls of classList) {
      const section = makeClassRuleSection(cls, classRules[cls] ?? [], commit);
      root.appendChild(section);
    }
  }

  return { root, sync };
}

function makeClassRuleSection(
  className: string,
  rules: ClassRuleBlock[],
  commit: ClassRuleCommitFn,
): HTMLDetailsElement {
  const blocks = normaliseRuleBlocks(className, rules);
  const details = document.createElement('details');
  details.className = 'sp-section sp-classrule';
  // Open if there are rules; collapse empty ones so they don't clutter.
  details.open = blocks.length > 0;
  const summary = document.createElement('summary');
  summary.className = 'sp-summary sp-classrule-summary';
  const title = document.createElement('span');
  title.className = 'sp-classrule-title';
  title.textContent = `.${className}`;
  const count = document.createElement('span');
  count.className = 'sp-classrule-count';
  count.textContent = blocks.length === 0 ? '(no rule)' : `${blocks.length}`;
  summary.appendChild(title);
  summary.appendChild(count);
  details.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'sp-content sp-classrule-content';
  details.appendChild(content);

  if (blocks.length === 0) {
    const note = document.createElement('div');
    note.className = 'sp-classrule-empty';
    note.textContent = `No matching rule for .${className} in this file.`;
    content.appendChild(note);
    return details;
  }

  for (const rule of blocks) {
    const selectorLabel = document.createElement('div');
    selectorLabel.className = 'sp-classrule-selector';
    selectorLabel.textContent = rule.selector;
    content.appendChild(selectorLabel);
    for (const decl of rule.declarations) {
      content.appendChild(makeDeclarationRow(rule.selector, decl, commit));
    }
    content.appendChild(makeAddDeclarationRow(rule.selector, commit));
  }

  return details;
}

function normaliseRuleBlocks(
  className: string,
  rules: ClassRuleBlock[],
): ClassRuleBlock[] {
  if (!Array.isArray(rules)) return [];
  if (rules.length === 0) return [];

  const maybeLegacyDeclarations = rules as unknown as ClassRuleDeclaration[];
  if (maybeLegacyDeclarations.every(isClassRuleDeclaration)) {
    return [{ selector: `.${className}`, declarations: maybeLegacyDeclarations }];
  }

  return rules.filter(isClassRuleBlock);
}

function isClassRuleBlock(value: unknown): value is ClassRuleBlock {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ClassRuleBlock>;
  return (
    typeof candidate.selector === 'string' &&
    Array.isArray(candidate.declarations) &&
    candidate.declarations.every(isClassRuleDeclaration)
  );
}

function isClassRuleDeclaration(value: unknown): value is ClassRuleDeclaration {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ClassRuleDeclaration>;
  return (
    typeof candidate.property === 'string' &&
    typeof candidate.value === 'string' &&
    typeof candidate.important === 'boolean'
  );
}

function makeDeclarationRow(
  selector: string,
  decl: ClassRuleDeclaration,
  commit: ClassRuleCommitFn,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sp-decl-row';

  const propLabel = document.createElement('label');
  propLabel.className = 'sp-decl-prop';
  propLabel.textContent = decl.property;
  row.appendChild(propLabel);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'sp-input sp-decl-value';
  valueInput.value = decl.value + (decl.important ? ' !important' : '');
  valueInput.spellcheck = false;
  valueInput.autocomplete = 'off';

  let lastCommitted = valueInput.value;
  let pendingCommitTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPendingCommit = (): void => {
    if (!pendingCommitTimer) return;
    clearTimeout(pendingCommitTimer);
    pendingCommitTimer = null;
  };
  const commitIfChanged = (): void => {
    clearPendingCommit();
    const v = valueInput.value.trim();
    if (v === lastCommitted.trim()) return;
    if (v === '') {
      lastCommitted = '';
      commit(selector, decl.property, null);
      return;
    }
    lastCommitted = v;
    commit(selector, decl.property, v);
  };
  const scheduleCommit = (): void => {
    clearPendingCommit();
    pendingCommitTimer = setTimeout(commitIfChanged, 350);
  };
  /** Bump immediately commits — matches the existing numericInput convention. */
  const commitValue = (next: string): void => {
    clearPendingCommit();
    valueInput.value = next;
    lastCommitted = next;
    commit(selector, decl.property, next);
  };
  valueInput.addEventListener('input', scheduleCommit);
  valueInput.addEventListener('blur', commitIfChanged);
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitIfChanged();
      valueInput.blur();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      clearPendingCommit();
      valueInput.value = lastCommitted;
      valueInput.blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = bumpStep({ shift: e.shiftKey, alt: e.altKey });
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step;
      const bumped = bumpCssValue(valueInput.value, delta);
      if (bumped !== null) {
        e.preventDefault();
        commitValue(bumped);
      }
    }
  });
  row.appendChild(valueInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'sp-decl-remove';
  removeBtn.setAttribute('aria-label', `Remove ${decl.property}`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    commit(selector, decl.property, null);
  });
  row.appendChild(removeBtn);

  return row;
}

function makeAddDeclarationRow(
  selector: string,
  commit: ClassRuleCommitFn,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sp-decl-add';

  const propInput = document.createElement('input');
  propInput.type = 'text';
  propInput.className = 'sp-input sp-decl-add-prop';
  propInput.placeholder = 'property';
  propInput.spellcheck = false;
  propInput.autocomplete = 'off';

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'sp-input sp-decl-add-value';
  valueInput.placeholder = 'value';
  valueInput.spellcheck = false;
  valueInput.autocomplete = 'off';

  const submit = (): void => {
    const prop = propInput.value.trim().toLowerCase();
    const value = valueInput.value.trim();
    if (!prop || !value) return;
    propInput.value = '';
    valueInput.value = '';
    commit(selector, prop, value);
  };

  for (const input of [propInput, valueInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  }
  valueInput.addEventListener('blur', () => {
    if (propInput.value.trim() && valueInput.value.trim()) submit();
  });

  row.appendChild(propInput);
  row.appendChild(valueInput);
  return row;
}

function makeChip(token: string, onRemove: (t: string) => void): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'sp-chip';
  const label = document.createElement('span');
  label.className = 'sp-chip-label';
  label.textContent = token;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'sp-chip-remove';
  remove.setAttribute('aria-label', `Remove class ${token}`);
  remove.textContent = '×';
  remove.addEventListener('click', (e) => {
    e.preventDefault();
    onRemove(token);
  });
  chip.appendChild(label);
  chip.appendChild(remove);
  return chip;
}
