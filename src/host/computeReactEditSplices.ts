import type {
  EditBlockHtml,
  EditBlockTag,
  EditElementAttrs,
  EditRemove,
  OffsetMap,
  ReactEditLockReason,
} from '../shared/protocol';
import { ALLOWED_BLOCK_TAGS } from './blockTagTransform';
import type { SpliceOp } from './undoStack';

type ReactMeta = NonNullable<OffsetMap['react']>;
type ReactElementMeta = ReactMeta['elements'][number];

export type ReactSpliceResult =
  | { ok: true; splices: SpliceOp[] }
  | { ok: false; reason: ReactEditLockReason | 'no-offsets' | 'bad-tag' };

export function computeReactRemoveSplices(input: {
  offsetMap: OffsetMap;
  commit: EditRemove;
}): ReactSpliceResult {
  const meta = input.offsetMap.react;
  if (!meta) return { ok: false, reason: 'no-offsets' };
  const locked = lockedSet(meta);
  const byId = new Map(input.offsetMap.elements.map((e) => [e.elementId, e]));
  const splices: SpliceOp[] = [];
  for (const id of input.commit.elementIds) {
    if (locked.has(id)) return { ok: false, reason: lockReason(meta, id) };
    const el = byId.get(id);
    if (!el) return { ok: false, reason: 'no-offsets' };
    splices.push({ startOffset: el.startOffset, endOffset: el.endOffset, replacement: '' });
  }
  return { ok: true, splices: rightToLeft(splices) };
}

export function computeReactBlockHtmlSplices(input: {
  offsetMap: OffsetMap;
  commit: EditBlockHtml;
}): ReactSpliceResult {
  const meta = input.offsetMap.react;
  if (!meta) return { ok: false, reason: 'no-offsets' };
  const block = input.offsetMap.blocks.find((b) => b.blockId === input.commit.blockId);
  if (!block || block.innerStartOffset === undefined || block.innerEndOffset === undefined) {
    return { ok: false, reason: 'no-offsets' };
  }
  if (lockedSet(meta).has(block.elementId)) {
    return { ok: false, reason: lockReason(meta, block.elementId) };
  }
  const reactBlock = meta.blocks.find((b) => b.blockId === block.blockId);
  if (!reactBlock?.staticInner) return { ok: false, reason: 'dynamic-expression' };
  const jsx = htmlFragmentToJsx(input.commit.newInnerHtml);
  const splices: SpliceOp[] = [
    { startOffset: block.innerStartOffset, endOffset: block.innerEndOffset, replacement: jsx },
  ];
  if (input.commit.newTagName) {
    const tagSplices = tagRenameSplices(meta, block.elementId, input.commit.newTagName);
    if (!tagSplices.ok) return tagSplices;
    splices.push(...tagSplices.splices);
  }
  return { ok: true, splices: rightToLeft(splices) };
}

export function computeReactBlockTagSplices(input: {
  offsetMap: OffsetMap;
  commit: EditBlockTag;
}): ReactSpliceResult {
  const meta = input.offsetMap.react;
  if (!meta) return { ok: false, reason: 'no-offsets' };
  const block = input.offsetMap.blocks.find((b) => b.blockId === input.commit.blockId);
  if (!block) return { ok: false, reason: 'no-offsets' };
  if (lockedSet(meta).has(block.elementId)) {
    return { ok: false, reason: lockReason(meta, block.elementId) };
  }
  return tagRenameSplices(meta, block.elementId, input.commit.newTagName);
}

export function computeReactAttrEditSplices(input: {
  offsetMap: OffsetMap;
  commit: EditElementAttrs;
}): ReactSpliceResult {
  const meta = input.offsetMap.react;
  if (!meta) return { ok: false, reason: 'no-offsets' };
  if (lockedSet(meta).has(input.commit.elementId)) {
    return { ok: false, reason: lockReason(meta, input.commit.elementId) };
  }
  const el = meta.elements.find((candidate) => candidate.elementId === input.commit.elementId);
  if (!el) return { ok: false, reason: 'no-offsets' };
  const splices: SpliceOp[] = [];
  for (const [domName, value] of Object.entries(input.commit.attrs)) {
    const name = domName === 'class' ? 'className' : domName;
    if (name === 'style') return { ok: false, reason: 'unsupported-jsx-attribute' };
    const existing = el.attributes.find((attr) => attr.name.toLowerCase() === name.toLowerCase());
    if (value === null) {
      if (existing) {
        splices.push({ startOffset: existing.startOffset, endOffset: existing.endOffset, replacement: '' });
      }
      continue;
    }
    const escaped = escapeJsxAttr(value);
    if (existing) {
      if (existing.kind !== 'string' || existing.valueStartOffset === undefined || existing.valueEndOffset === undefined) {
        return { ok: false, reason: 'unsupported-jsx-attribute' };
      }
      splices.push({
        startOffset: existing.valueStartOffset,
        endOffset: existing.valueEndOffset,
        replacement: escaped,
      });
    } else {
      splices.push({
        startOffset: el.openingEndOffset - 1,
        endOffset: el.openingEndOffset - 1,
        replacement: ` ${name}="${escaped}"`,
      });
    }
  }
  return { ok: true, splices: coalesceAttrSpacing(splices) };
}

function tagRenameSplices(meta: ReactMeta, elementId: number, newTagName: string): ReactSpliceResult {
  const tag = newTagName.toLowerCase();
  if (!ALLOWED_BLOCK_TAGS.has(tag)) return { ok: false, reason: 'bad-tag' };
  const el = meta.elements.find((candidate) => candidate.elementId === elementId);
  if (!el) return { ok: false, reason: 'no-offsets' };
  if (el.closeNameStartOffset === undefined || el.closeNameEndOffset === undefined) {
    return { ok: false, reason: 'dynamic-expression' };
  }
  return {
    ok: true,
    splices: rightToLeft([
      { startOffset: el.openNameStartOffset, endOffset: el.openNameEndOffset, replacement: tag },
      { startOffset: el.closeNameStartOffset, endOffset: el.closeNameEndOffset, replacement: tag },
    ]),
  };
}

function htmlFragmentToJsx(html: string): string {
  return html
    .replace(/\sclass=/gi, ' className=')
    .replace(/\sfor=/gi, ' htmlFor=')
    .replace(/\sdata-finesse-id=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function escapeJsxAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lockedSet(meta: ReactMeta): Set<number> {
  return new Set(meta.lockedElementIds);
}

function lockReason(meta: ReactMeta, elementId: number): ReactEditLockReason {
  return meta.locks.find((l) => l.elementId === elementId)?.reason ?? 'dynamic-expression';
}

function coalesceAttrSpacing(splices: SpliceOp[]): SpliceOp[] {
  return rightToLeft(splices.filter((s) => s.startOffset !== s.endOffset || s.replacement.length > 0));
}

function rightToLeft(splices: SpliceOp[]): SpliceOp[] {
  return [...splices].sort((a, b) => b.startOffset - a.startOffset);
}
