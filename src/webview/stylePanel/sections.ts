/**
 * Section renderers for the side panel. Each section returns:
 *   - `root`: a `<details>` element to drop into the panel body
 *   - `sync(snapshot)`: pull current values from a {@link ElementStyleSnapshot}
 *
 * Sections never write to the DOM directly; they call `commit(props)` which
 * the controller routes through the iframe's edit pipeline (panelStyleEdit).
 */

import type { ElementStyleSnapshot } from '../../shared/protocol';
import {
  boxSidesInput,
  colorInput,
  numericInput,
  row,
  segmentInput,
  selectInput,
  textInput,
  type BoxSidesHandle,
  type InputHandle,
} from './inputs';

export type CommitFn = (props: Record<string, string | null>) => void;

export interface SectionHandle {
  root: HTMLDetailsElement;
  sync(snapshot: ElementStyleSnapshot): void;
  setRelevant?: (relevant: boolean) => void;
}

function makeSection(
  title: string,
  defaultOpen: boolean,
  build: (content: HTMLElement) => Omit<SectionHandle, 'root'>,
): SectionHandle {
  const details = document.createElement('details');
  details.className = 'sp-section';
  if (defaultOpen) details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'sp-summary';
  summary.textContent = title;
  details.appendChild(summary);
  const content = document.createElement('div');
  content.className = 'sp-content';
  details.appendChild(content);
  const inner = build(content);
  return { root: details, ...inner };
}

const DISPLAY_OPTIONS = [
  { value: 'block', label: 'block' },
  { value: 'inline-block', label: 'inline-block' },
  { value: 'inline', label: 'inline' },
  { value: 'flex', label: 'flex' },
  { value: 'inline-flex', label: 'inline-flex' },
  { value: 'grid', label: 'grid' },
  { value: 'inline-grid', label: 'inline-grid' },
  { value: 'none', label: 'none' },
];

export function layoutSection(commit: CommitFn): SectionHandle {
  let display: InputHandle<string>;
  return makeSection('Layout', true, (content) => {
    display = selectInput({
      options: DISPLAY_OPTIONS,
      onCommit: (v) => commit({ display: v }),
    });
    content.appendChild(row('Display', display.root));
    return {
      sync(snapshot) {
        display.set(snapshot.computed.display);
      },
    };
  });
}

export function spacingSection(commit: CommitFn): SectionHandle {
  let padding: BoxSidesHandle;
  let margin: BoxSidesHandle;
  return makeSection('Spacing', true, (content) => {
    margin = boxSidesInput({
      prefix: 'margin',
      centerLabel: '',
      onCommit: commit,
    });
    const innerHost = margin.root.querySelector('.sp-box-inner') as HTMLElement | null;
    padding = boxSidesInput({
      prefix: 'padding',
      centerLabel: 'ELEMENT',
      onCommit: commit,
    });
    if (innerHost) {
      innerHost.textContent = '';
      innerHost.style.padding = '0';
      innerHost.style.background = 'transparent';
      innerHost.style.border = 'none';
      innerHost.appendChild(padding.root);
    } else {
      content.appendChild(padding.root);
    }
    content.appendChild(margin.root);
    return {
      sync(snapshot) {
        const c = snapshot.computed;
        margin.set({
          top: formatBoxValue(c.marginTop),
          right: formatBoxValue(c.marginRight),
          bottom: formatBoxValue(c.marginBottom),
          left: formatBoxValue(c.marginLeft),
        });
        padding.set({
          top: formatBoxValue(c.paddingTop),
          right: formatBoxValue(c.paddingRight),
          bottom: formatBoxValue(c.paddingBottom),
          left: formatBoxValue(c.paddingLeft),
        });
      },
    };
  });
}

function formatBoxValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0px') return trimmed === '0px' ? '0' : '';
  if (/^-?\d*\.?\d+px$/.test(trimmed)) return trimmed.replace(/px$/, '');
  return trimmed;
}

const BORDER_STYLES = [
  { value: 'none', label: 'none' },
  { value: 'solid', label: 'solid' },
  { value: 'dashed', label: 'dashed' },
  { value: 'dotted', label: 'dotted' },
  { value: 'double', label: 'double' },
  { value: 'groove', label: 'groove' },
  { value: 'ridge', label: 'ridge' },
  { value: 'inset', label: 'inset' },
  { value: 'outset', label: 'outset' },
];

export function borderSection(commit: CommitFn): SectionHandle {
  let width: InputHandle<string>;
  let style: InputHandle<string>;
  let color: InputHandle<string>;
  let radius: InputHandle<string>;
  return makeSection('Border', false, (content) => {
    width = numericInput({
      onCommit: (v) => commit({ 'border-width': v || null }),
      placeholder: '0',
    });
    style = selectInput({
      options: BORDER_STYLES,
      onCommit: (v) => commit({ 'border-style': v }),
    });
    color = colorInput({
      onCommit: (v) => commit({ 'border-color': v || null }),
      placeholder: '#000',
    });
    radius = numericInput({
      onCommit: (v) => commit({ 'border-radius': v || null }),
      placeholder: '0',
    });
    content.appendChild(row('Width', width.root));
    content.appendChild(row('Style', style.root));
    content.appendChild(row('Color', color.root));
    content.appendChild(row('Radius', radius.root));
    return {
      sync(snapshot) {
        const c = snapshot.computed;
        width.set(formatLength(c.borderTopWidth));
        style.set(c.borderTopStyle || 'none');
        color.set(rgbToHexIfOpaque(c.borderTopColor));
        radius.set(formatLength(c.borderTopLeftRadius));
      },
    };
  });
}

export function backgroundSection(commit: CommitFn): SectionHandle {
  let color: InputHandle<string>;
  return makeSection('Background', false, (content) => {
    color = colorInput({
      onCommit: (v) => commit({ 'background-color': v || null }),
      placeholder: 'transparent',
    });
    content.appendChild(row('Color', color.root));
    return {
      sync(snapshot) {
        color.set(rgbToHexIfOpaque(snapshot.computed.backgroundColor));
      },
    };
  });
}

const FLEX_DIRECTIONS = [
  { value: 'row', label: '→' },
  { value: 'row-reverse', label: '←' },
  { value: 'column', label: '↓' },
  { value: 'column-reverse', label: '↑' },
];

const JUSTIFY_OPTIONS = [
  { value: 'flex-start', label: 'start' },
  { value: 'center', label: 'center' },
  { value: 'flex-end', label: 'end' },
  { value: 'space-between', label: 'between' },
  { value: 'space-around', label: 'around' },
  { value: 'space-evenly', label: 'evenly' },
];

const ALIGN_OPTIONS = [
  { value: 'stretch', label: 'stretch' },
  { value: 'flex-start', label: 'start' },
  { value: 'center', label: 'center' },
  { value: 'flex-end', label: 'end' },
  { value: 'baseline', label: 'baseline' },
];

const WRAP_OPTIONS = [
  { value: 'nowrap', label: 'nowrap' },
  { value: 'wrap', label: 'wrap' },
  { value: 'wrap-reverse', label: 'reverse' },
];

export function flexSection(commit: CommitFn): SectionHandle {
  let direction: InputHandle<string>;
  let justify: InputHandle<string>;
  let align: InputHandle<string>;
  let wrap: InputHandle<string>;
  let gap: InputHandle<string>;
  const handle = makeSection('Flex', false, (content) => {
    direction = segmentInput({
      options: FLEX_DIRECTIONS,
      onCommit: (v) => commit({ 'flex-direction': v }),
    });
    justify = selectInput({
      options: JUSTIFY_OPTIONS,
      onCommit: (v) => commit({ 'justify-content': v }),
    });
    align = selectInput({
      options: ALIGN_OPTIONS,
      onCommit: (v) => commit({ 'align-items': v }),
    });
    wrap = selectInput({
      options: WRAP_OPTIONS,
      onCommit: (v) => commit({ 'flex-wrap': v }),
    });
    gap = numericInput({
      onCommit: (v) => commit({ gap: v || null }),
      placeholder: '0',
    });
    content.appendChild(row('Dir', direction.root));
    content.appendChild(row('Justify', justify.root));
    content.appendChild(row('Align', align.root));
    content.appendChild(row('Wrap', wrap.root));
    content.appendChild(row('Gap', gap.root));
    return {
      sync(snapshot) {
        const c = snapshot.computed;
        direction.set(c.flexDirection || 'row');
        justify.set(c.justifyContent || 'flex-start');
        align.set(c.alignItems || 'stretch');
        wrap.set(c.flexWrap || 'nowrap');
        gap.set(formatLength(c.rowGap));
      },
    };
  });
  return {
    root: handle.root,
    sync: handle.sync,
    setRelevant(r) {
      handle.root.style.display = r ? '' : 'none';
      if (r && !handle.root.open) handle.root.open = true;
    },
  };
}

export function gridSection(commit: CommitFn): SectionHandle {
  let cols: InputHandle<string>;
  let rows: InputHandle<string>;
  let gap: InputHandle<string>;

  const handle = makeSection('Grid', false, (content) => {
    cols = textInput({
      placeholder: 'e.g. 1fr 1fr 1fr',
      onCommit: (v) => commit({ 'grid-template-columns': v || null }),
    });
    rows = textInput({
      placeholder: 'e.g. auto',
      onCommit: (v) => commit({ 'grid-template-rows': v || null }),
    });
    gap = numericInput({
      onCommit: (v) => commit({ gap: v || null }),
      placeholder: '0',
    });
    content.appendChild(row('Cols', cols.root));
    content.appendChild(row('Rows', rows.root));
    content.appendChild(row('Gap', gap.root));
    return {
      sync(snapshot) {
        const c = snapshot.computed;
        cols.set(c.gridTemplateColumns === 'none' ? '' : c.gridTemplateColumns);
        rows.set(c.gridTemplateRows === 'none' ? '' : c.gridTemplateRows);
        gap.set(formatLength(c.rowGap));
      },
    };
  });
  return {
    root: handle.root,
    sync: handle.sync,
    setRelevant(r) {
      handle.root.style.display = r ? '' : 'none';
      if (r && !handle.root.open) handle.root.open = true;
    },
  };
}

function formatLength(value: string): string {
  if (!value) return '';
  if (value === '0px') return '0';
  return value;
}

function rgbToHexIfOpaque(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed === 'rgba(0, 0, 0, 0)' || trimmed === 'transparent') return '';
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(trimmed);
  if (!m) return trimmed;
  const a = m[4] !== undefined ? Number.parseFloat(m[4]) : 1;
  if (a < 1) return trimmed;
  const r = Number.parseInt(m[1], 10);
  const g = Number.parseInt(m[2], 10);
  const b = Number.parseInt(m[3], 10);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
