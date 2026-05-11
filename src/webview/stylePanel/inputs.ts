/**
 * Compact input primitives used inside the side panel sections.
 *
 * Each primitive returns its root DOM element plus a small `get`/`set` API.
 * Inputs commit on blur or Enter (numeric, color, text); selects commit on
 * change. Commits flow through the supplied `onCommit` callback.
 *
 * Themed exclusively with VS Code CSS variables so the panel matches the
 * surrounding webview chrome.
 */

export interface InputHandle<T = string> {
  root: HTMLElement;
  get(): T;
  set(value: T): void;
}

export interface NumericInputOpts {
  units?: readonly string[];
  defaultUnit?: string;
  step?: number;
  placeholder?: string;
  onCommit: (value: string) => void;
}

const DEFAULT_LENGTH_UNITS = ['px', '%', 'em', 'rem', 'vh', 'vw', 'auto'] as const;

export function numericInput(opts: NumericInputOpts): InputHandle<string> {
  const root = document.createElement('div');
  root.className = 'sp-rowctl';

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'sp-input sp-num';
  input.placeholder = opts.placeholder ?? '';

  const unitSel = document.createElement('select');
  unitSel.className = 'sp-unit';
  for (const u of opts.units ?? DEFAULT_LENGTH_UNITS) {
    const o = document.createElement('option');
    o.value = u;
    o.textContent = u;
    unitSel.appendChild(o);
  }
  unitSel.value = opts.defaultUnit ?? (opts.units ?? DEFAULT_LENGTH_UNITS)[0];

  function readCombined(): string {
    const raw = input.value.trim();
    if (raw === '') return '';
    const unit = unitSel.value;
    if (unit === 'auto') return 'auto';
    if (/^-?\d*\.?\d+$/.test(raw)) return `${raw}${unit}`;
    const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(raw);
    if (m) {
      if (m[2]) {
        unitSel.value = matchUnit(m[2], unitSel) ?? unitSel.value;
      }
      return `${m[1]}${unitSel.value}`;
    }
    return raw;
  }

  function commit(): void {
    opts.onCommit(readCombined());
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const n = Number.parseFloat(input.value);
      if (Number.isFinite(n)) {
        e.preventDefault();
        const step = opts.step ?? 1;
        const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? step * 10 : step);
        input.value = String(round(n + delta));
        commit();
      }
    }
  });
  unitSel.addEventListener('change', commit);

  root.appendChild(input);
  root.appendChild(unitSel);

  return {
    root,
    get: readCombined,
    set(value: string) {
      const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(value);
      if (value === '' || !m) {
        input.value = value === 'auto' ? '' : '';
        if (value === 'auto') unitSel.value = 'auto';
        return;
      }
      input.value = m[1];
      if (m[2]) {
        const u = matchUnit(m[2], unitSel);
        if (u) unitSel.value = u;
      }
    },
  };
}

function matchUnit(unit: string, sel: HTMLSelectElement): string | null {
  const target = unit.toLowerCase();
  for (const o of Array.from(sel.options)) {
    if (o.value === target) return o.value;
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ColorInputOpts {
  onCommit: (value: string) => void;
  placeholder?: string;
}

export function colorInput(opts: ColorInputOpts): InputHandle<string> {
  const root = document.createElement('div');
  root.className = 'sp-color';

  const swatch = document.createElement('label');
  swatch.className = 'sp-swatch';
  const picker = document.createElement('input');
  picker.type = 'color';
  swatch.appendChild(picker);

  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'sp-input';
  text.placeholder = opts.placeholder ?? '';

  function paintSwatch(value: string): void {
    swatch.style.setProperty('--sp-sw-color', value || 'transparent');
  }

  picker.addEventListener('input', () => {
    text.value = picker.value;
    paintSwatch(picker.value);
  });
  picker.addEventListener('change', () => {
    opts.onCommit(picker.value);
  });
  text.addEventListener('blur', () => {
    paintSwatch(text.value);
    opts.onCommit(text.value);
    syncPickerFromText();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      paintSwatch(text.value);
      opts.onCommit(text.value);
      syncPickerFromText();
      text.blur();
    }
  });

  function syncPickerFromText(): void {
    const value = text.value.trim();
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;
    if (hex.test(value)) {
      picker.value = value.length === 4 ? expandShortHex(value) : value;
    }
  }

  root.appendChild(swatch);
  root.appendChild(text);

  return {
    root,
    get: () => text.value,
    set(value: string) {
      text.value = value;
      paintSwatch(value);
      syncPickerFromText();
    },
  };
}

function expandShortHex(hex: string): string {
  const r = hex[1];
  const g = hex[2];
  const b = hex[3];
  return `#${r}${r}${g}${g}${b}${b}`;
}

export interface SelectInputOpts {
  options: ReadonlyArray<{ value: string; label: string }>;
  onCommit: (value: string) => void;
}

export function selectInput(opts: SelectInputOpts): InputHandle<string> {
  const sel = document.createElement('select');
  sel.className = 'sp-select';
  for (const o of opts.options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => opts.onCommit(sel.value));
  return {
    root: sel,
    get: () => sel.value,
    set(value: string) {
      const has = Array.from(sel.options).some((o) => o.value === value);
      if (has) sel.value = value;
      else if (value) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        sel.appendChild(opt);
        sel.value = value;
      }
    },
  };
}

export interface SegmentInputOpts {
  options: ReadonlyArray<{ value: string; label: string; title?: string }>;
  onCommit: (value: string) => void;
}

export function segmentInput(opts: SegmentInputOpts): InputHandle<string> {
  const root = document.createElement('div');
  root.className = 'sp-segment';
  let value = '';
  const buttons: HTMLButtonElement[] = [];
  for (const o of opts.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-segbtn';
    btn.dataset.value = o.value;
    btn.textContent = o.label;
    if (o.title) btn.title = o.title;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      value = o.value;
      paint();
      opts.onCommit(value);
    });
    buttons.push(btn);
    root.appendChild(btn);
  }
  function paint(): void {
    for (const b of buttons) {
      b.setAttribute('aria-pressed', b.dataset.value === value ? 'true' : 'false');
    }
  }
  return {
    root,
    get: () => value,
    set(v: string) {
      value = v;
      paint();
    },
  };
}

export function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement('div');
  r.className = 'sp-row';
  const l = document.createElement('label');
  l.textContent = label;
  const c = document.createElement('div');
  c.className = 'sp-rowctl';
  c.appendChild(control);
  r.appendChild(l);
  r.appendChild(c);
  return r;
}

export interface BoxSidesInputOpts {
  prefix: 'padding' | 'margin';
  centerLabel: string;
  onCommit: (changes: Record<string, string | null>) => void;
}

export interface BoxSidesHandle {
  root: HTMLElement;
  set(values: { top: string; right: string; bottom: string; left: string }): void;
}

export function boxSidesInput(opts: BoxSidesInputOpts): BoxSidesHandle {
  const root = document.createElement('div');
  root.className = 'sp-box';
  const label = document.createElement('span');
  label.className = `sp-box-label ${opts.prefix === 'margin' ? 'outer' : 'inner'}`;
  label.textContent = opts.prefix.toUpperCase();
  root.appendChild(label);

  const inner = document.createElement('div');
  inner.className = 'sp-box-inner';
  inner.textContent = opts.centerLabel;
  root.appendChild(inner);

  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const inputs = new Map<string, HTMLInputElement>();
  for (const side of sides) {
    const wrap = document.createElement('div');
    wrap.className = `sp-box-side ${side}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sp-box-input';
    input.placeholder = '–';
    input.addEventListener('blur', () => commit(side, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(side, input.value);
        input.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(input.value.trim());
        if (m) {
          const n = Number.parseFloat(m[1]);
          if (Number.isFinite(n)) {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
            input.value = `${round(n + delta)}${m[2] || 'px'}`;
            commit(side, input.value);
          }
        }
      }
    });
    wrap.appendChild(input);
    root.appendChild(wrap);
    inputs.set(side, input);
  }

  function commit(side: string, raw: string): void {
    const value = normaliseLengthValue(raw);
    opts.onCommit({ [`${opts.prefix}-${side}`]: value });
  }

  return {
    root,
    set(values) {
      for (const side of sides) {
        const inp = inputs.get(side);
        if (inp) inp.value = values[side] ?? '';
      }
    },
  };
}

function normaliseLengthValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed === '0') return '0';
  if (/^-?\d*\.?\d+$/.test(trimmed)) return `${trimmed}px`;
  return trimmed;
}

export interface TextInputOpts {
  placeholder?: string;
  onCommit: (value: string) => void;
}

export function textInput(opts: TextInputOpts): InputHandle<string> {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sp-input';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.addEventListener('blur', () => opts.onCommit(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      opts.onCommit(input.value.trim());
      input.blur();
    }
  });
  return {
    root: input,
    get: () => input.value,
    set(v: string) {
      input.value = v;
    },
  };
}
