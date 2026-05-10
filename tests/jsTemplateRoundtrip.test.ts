import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeForJsTemplate } from '../src/host/jsTemplateEscape';
import { walkEditableInJs } from '../src/host/parse/walkEditableInJs';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

/**
 * Mimic the host's right-to-left splice pipeline for plain text-node edits.
 * Each edit replaces `[startOffset, endOffset)` with the (escaped) new text.
 */
function applyTextEdits(
  source: string,
  edits: ReadonlyArray<{ startOffset: number; endOffset: number; newText: string }>,
  jsMode: boolean,
): string {
  const ordered = [...edits].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const e of ordered) {
    const replacement = jsMode ? escapeForJsTemplate(e.newText) : e.newText;
    out = out.slice(0, e.startOffset) + replacement + out.slice(e.endOffset);
  }
  return out;
}

describe('JS template-literal round-trip', () => {
  it('lit-template.ts: editable text nodes match the literal body, surrounding code is byte-perfect', () => {
    const src = loadFixture('lit-template.ts');
    const { offsetMap, literals } = walkEditableInJs(src, 1);
    expect(literals).toHaveLength(1);
    expect(offsetMap.textNodes.length).toBeGreaterThan(0);

    const texts = offsetMap.textNodes.map((tn) => tn.originalText.trim());
    expect(texts).toContain('Welcome to the demo');
    expect(texts).toContain('This text is editable. Click anywhere to begin.');
    expect(texts).toContain('Plain paragraphs around an interpolation remain editable.');
    expect(texts.some((t) => t.includes('${name}'))).toBe(false);

    for (const tn of offsetMap.textNodes) {
      expect(src.slice(tn.startOffset, tn.endOffset)).toBe(tn.originalText);
    }
  });

  it('lit-template.ts: edit one text node, file outside the splice is unchanged', () => {
    const src = loadFixture('lit-template.ts');
    const { offsetMap } = walkEditableInJs(src, 1);
    const tn = offsetMap.textNodes.find((t) => t.originalText.trim() === 'Welcome to the demo');
    expect(tn).toBeDefined();

    const updated = applyTextEdits(
      src,
      [{ startOffset: tn!.startOffset, endOffset: tn!.endOffset, newText: 'Welcome, friend' }],
      true,
    );

    expect(updated).toContain('<h2>Welcome, friend</h2>');
    expect(updated.slice(0, tn!.startOffset)).toBe(src.slice(0, tn!.startOffset));
    expect(updated.slice(tn!.startOffset + 'Welcome, friend'.length)).toBe(
      src.slice(tn!.endOffset),
    );
  });

  it('lit-template.ts: edits containing backticks/${ are escaped so the file still parses', () => {
    const src = loadFixture('lit-template.ts');
    const { offsetMap } = walkEditableInJs(src, 1);
    const tn = offsetMap.textNodes.find((t) =>
      t.originalText.includes('Plain paragraphs'),
    );
    expect(tn).toBeDefined();

    const updated = applyTextEdits(
      src,
      [
        {
          startOffset: tn!.startOffset,
          endOffset: tn!.endOffset,
          newText: 'Cost: `5` and ${not_an_interp}',
        },
      ],
      true,
    );

    expect(updated).toContain('Cost: \\`5\\` and \\${not_an_interp}');
    expect(updated.includes('`5`')).toBe(false);
  });

  it('multi-template.ts: both literals contribute editable text nodes', () => {
    const src = loadFixture('multi-template.ts');
    const { offsetMap, literals } = walkEditableInJs(src, 1);
    expect(literals).toHaveLength(2);

    const texts = offsetMap.textNodes.map((t) => t.originalText.trim());
    expect(texts).toContain('Header section');
    expect(texts).toContain('Click to edit the header text.');
    expect(texts).toContain('All rights reserved.');
    expect(texts.some((t) => t.includes('${year}'))).toBe(false);
  });

  it('multi-template.ts: editing a node in the second literal leaves the first untouched', () => {
    const src = loadFixture('multi-template.ts');
    const { offsetMap } = walkEditableInJs(src, 1);
    const tn = offsetMap.textNodes.find((t) => t.originalText.trim() === 'All rights reserved.');
    expect(tn).toBeDefined();

    const updated = applyTextEdits(
      src,
      [{ startOffset: tn!.startOffset, endOffset: tn!.endOffset, newText: 'Some rights reserved.' }],
      true,
    );

    expect(updated).toContain('Some rights reserved.');
    expect(updated).toContain('Header section');
    expect(updated.slice(0, tn!.startOffset)).toBe(src.slice(0, tn!.startOffset));
  });
});
