/**
 * Inline SVG icon set for the format toolbar. Phosphor-/Lucide-inspired
 * 16×16 strokes, hand-tuned for a 1px stroke at 16px.
 */

const SVG = (path: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const ICONS = {
  bold: SVG(
    '<path d="M4 3h4.5a2.25 2.25 0 0 1 0 4.5H4z"/><path d="M4 7.5h5a2.25 2.25 0 0 1 0 4.5H4z"/>',
  ),
  italic: SVG('<line x1="6.5" y1="3" x2="11.5" y2="3"/><line x1="4.5" y1="13" x2="9.5" y2="13"/><line x1="9.5" y1="3" x2="6.5" y2="13"/>'),
  underline: SVG(
    '<path d="M4 3v5a4 4 0 0 0 8 0V3"/><line x1="3.5" y1="13.25" x2="12.5" y2="13.25"/>',
  ),
  strike: SVG(
    '<path d="M4 5.5a2.5 2.5 0 0 1 2.5-2.5h3A2.5 2.5 0 0 1 12 5.5"/><line x1="2.5" y1="8" x2="13.5" y2="8"/><path d="M11.5 10.5A2.5 2.5 0 0 1 9 13H7a2.5 2.5 0 0 1-2.5-2.5"/>',
  ),
  code: SVG(
    '<polyline points="5,4.5 2,8 5,11.5"/><polyline points="11,4.5 14,8 11,11.5"/>',
  ),
  link: SVG(
    '<path d="M7 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1"/><path d="M9 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1"/>',
  ),
  clear: SVG(
    '<path d="M3 13l5-5"/><path d="M5.5 5.5l3 3"/><path d="M9 3l3 3-4.5 4.5L4.5 7.5z"/><line x1="3.5" y1="13" x2="13" y2="13"/>',
  ),
};

export type IconName = keyof typeof ICONS;
