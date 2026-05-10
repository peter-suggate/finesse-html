import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBlockHtmlSplices } from '../src/host/computeBlockHtmlSplices';
import { walkEditable } from '../src/host/parse/walkEditable';
import { walkEditableInJs } from '../src/host/parse/walkEditableInJs';
import {
  computeInverseSplices,
  UndoStack,
  type SpliceOp,
  type UndoEntry,
} from '../src/host/undoStack';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

function applySplices(source: string, splices: readonly SpliceOp[]): string {
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const s of ordered) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}

/** Simulate the host pipeline: capture inverse, apply, return both new state and entry. */
function applyAndRecord(source: string, splices: SpliceOp[], version: number): { source: string; entry: UndoEntry } {
  const inverse = computeInverseSplices(source, splices);
  const next = applySplices(source, splices);
  return {
    source: next,
    entry: {
      forward: splices,
      inverse,
      versionBefore: version,
      versionAfter: version + 1,
    },
  };
}

describe('undo/redo round-trip via the recorded splice pipeline', () => {
  it('text-node edit on plain HTML: apply → undo → redo restores each state', () => {
    const original = '<!doctype html><html><body><p>Hello world</p><p>Second</p></body></html>';
    const map = walkEditable(original, 1);
    const tn = map.textNodes.find((t) => t.originalText === 'Hello world')!;

    const stack = new UndoStack();
    const e1 = applyAndRecord(
      original,
      [{ startOffset: tn.startOffset, endOffset: tn.endOffset, replacement: 'Hi there' }],
      1,
    );
    stack.push(e1.entry);
    expect(e1.source).toContain('<p>Hi there</p>');
    expect(e1.source).toContain('<p>Second</p>');

    // Undo.
    const undone = applySplices(e1.source, stack.popUndo()!.inverse);
    expect(undone).toBe(original);

    // Redo (entry was pushed back to redoStack — pop and re-apply forward).
    const redoEntry = e1.entry; // we'd have pushed it via pushRedo in real flow
    const redone = applySplices(undone, redoEntry.forward);
    expect(redone).toBe(e1.source);
  });

  it('two stacked edits: apply E1, apply E2, undo, undo, redo, redo round-trips', () => {
    const v0 = '<!doctype html><html><body><p>One</p><p>Two</p></body></html>';
    const map = walkEditable(v0, 1);
    const t1 = map.textNodes.find((t) => t.originalText === 'One')!;
    const t2 = map.textNodes.find((t) => t.originalText === 'Two')!;

    const e1 = applyAndRecord(
      v0,
      [{ startOffset: t1.startOffset, endOffset: t1.endOffset, replacement: 'ONE' }],
      1,
    );
    const e2 = applyAndRecord(
      e1.source,
      [{ startOffset: t2.startOffset, endOffset: t2.endOffset, replacement: 'TWO' }],
      2,
    );

    expect(e2.source).toContain('<p>ONE</p>');
    expect(e2.source).toContain('<p>TWO</p>');

    // Undo E2 → state v1 (only ONE applied).
    const afterUndoE2 = applySplices(e2.source, e2.entry.inverse);
    expect(afterUndoE2).toBe(e1.source);

    // Undo E1 → original v0.
    const afterUndoE1 = applySplices(afterUndoE2, e1.entry.inverse);
    expect(afterUndoE1).toBe(v0);

    // Redo E1 → e1.source.
    const afterRedoE1 = applySplices(afterUndoE1, e1.entry.forward);
    expect(afterRedoE1).toBe(e1.source);

    // Redo E2 → e2.source.
    const afterRedoE2 = applySplices(afterRedoE1, e2.entry.forward);
    expect(afterRedoE2).toBe(e2.source);
  });

  it('block-html commit round-trips through inverse splice', () => {
    const v0 = '<!doctype html><html><body><p>plain</p></body></html>';
    const map = walkEditable(v0, 1);
    const block = map.blocks.find((b) => b.tagName === 'p')!;

    const planResult = computeBlockHtmlSplices({
      source: v0,
      offsetMap: map,
      blockId: block.blockId,
      newInnerHtml: '<strong>BOLD</strong>',
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const splices: SpliceOp[] = planResult.splices.map((s) => ({
      startOffset: s.startOffset,
      endOffset: s.endOffset,
      replacement: s.replacement,
    }));
    const e = applyAndRecord(v0, splices, 1);
    expect(e.source).toContain('<p><strong>BOLD</strong></p>');

    const reverted = applySplices(e.source, e.entry.inverse);
    expect(reverted).toBe(v0);

    const redone = applySplices(reverted, e.entry.forward);
    expect(redone).toBe(e.source);
  });

  it('JS template-literal: text-node edit round-trips back to original JS source', () => {
    const v0 = loadFixture('lit-template.ts');
    const { offsetMap } = walkEditableInJs(v0, 1);
    const tn = offsetMap.textNodes.find((t) => t.originalText.trim() === 'Welcome to the demo')!;

    const e = applyAndRecord(
      v0,
      [{ startOffset: tn.startOffset, endOffset: tn.endOffset, replacement: 'Welcome, friend' }],
      1,
    );
    expect(e.source).toContain('<h2>Welcome, friend</h2>');

    const reverted = applySplices(e.source, e.entry.inverse);
    expect(reverted).toBe(v0);

    const redone = applySplices(reverted, e.entry.forward);
    expect(redone).toBe(e.source);
  });

  it('UndoStack lifecycle: push/popUndo/pushRedo/popRedo through several cycles', () => {
    const v0 = '<!doctype html><html><body><p>A</p></body></html>';
    const map = walkEditable(v0, 1);
    const tn = map.textNodes[0];
    const stack = new UndoStack();
    const e = applyAndRecord(
      v0,
      [{ startOffset: tn.startOffset, endOffset: tn.endOffset, replacement: 'B' }],
      1,
    );
    stack.push(e.entry);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);

    const undone = stack.popUndo()!;
    stack.pushRedo(undone);
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(true);

    const redone = stack.popRedo()!;
    stack.pushUndo(redone);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
  });
});
