/**
 * Pure splice computation for block-html commits. Separated from the
 * VSCode-bound applier so the round-trip can be unit-tested.
 */

import type { OffsetMap } from '../shared/protocol';
import { ALLOWED_BLOCK_TAGS, computeBlockTagSplices, type Splice } from './blockTagTransform';
import { sanitizeBlockHtml } from './sanitizeBlockHtml';

export interface ComputeBlockHtmlInput {
  source: string;
  offsetMap: OffsetMap;
  blockId: number;
  newInnerHtml: string;
  /** Optional combined tag rename. */
  newTagName?: string;
}

export type ComputeBlockHtmlResult =
  | { ok: true; splices: Splice[] }
  | { ok: false; reason: 'unknown-block' | 'no-inner-offsets' | 'bad-tag' };

/**
 * Plan the WorkspaceEdit splices needed to apply an editBlockHtml message
 * (with optional combined tag rename). Right-to-left ordering applied so
 * earlier offsets stay valid as later splices are applied.
 */
export function computeBlockHtmlSplices(
  input: ComputeBlockHtmlInput,
): ComputeBlockHtmlResult {
  const block = input.offsetMap.blocks.find((b) => b.blockId === input.blockId);
  if (!block) return { ok: false, reason: 'unknown-block' };
  if (block.innerStartOffset === undefined || block.innerEndOffset === undefined) {
    return { ok: false, reason: 'no-inner-offsets' };
  }
  if (block.innerEndOffset < block.innerStartOffset) {
    return { ok: false, reason: 'no-inner-offsets' };
  }

  const sanitized = sanitizeBlockHtml(input.newInnerHtml);
  const splices: Splice[] = [
    {
      startOffset: block.innerStartOffset,
      endOffset: block.innerEndOffset,
      replacement: sanitized,
    },
  ];

  if (input.newTagName) {
    const newTag = input.newTagName.toLowerCase();
    if (!ALLOWED_BLOCK_TAGS.has(newTag)) return { ok: false, reason: 'bad-tag' };
    const element = input.offsetMap.elements.find((e) => e.elementId === block.elementId);
    if (!element) return { ok: false, reason: 'unknown-block' };
    const tagSplices = computeBlockTagSplices({
      source: input.source,
      elementStart: element.startOffset,
      elementEnd: element.endOffset,
      innerStart: block.innerStartOffset,
      innerEnd: block.innerEndOffset,
      oldTag: block.tagName,
      newTag,
    });
    if (!tagSplices) return { ok: false, reason: 'bad-tag' };
    for (const s of tagSplices) splices.push(s);
  }

  splices.sort((a, b) => b.startOffset - a.startOffset);
  return { ok: true, splices };
}

/** Apply pre-sorted splices to a source string. Useful for tests. */
export function applySplicesToSource(source: string, splices: readonly Splice[]): string {
  // Splices are emitted right-to-left, so apply in given order.
  let out = source;
  for (const s of splices) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}
