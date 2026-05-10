import type { OffsetMap } from '../../shared/protocol';
import {
  composeTemplateLiterals,
  composedToSource,
  extractTemplateLiterals,
  type ComposedChunk,
  type ExtractOptions,
  type TemplateLiteralRange,
} from './extractTemplateLiterals';
import { walkEditable, type WalkOptions } from './walkEditable';

export interface WalkJsOptions extends WalkOptions, ExtractOptions {}

export interface JsWalkResult {
  /** OffsetMap with all offsets translated back to JS-source coordinates. */
  offsetMap: OffsetMap;
  /** OffsetMap with offsets in composed-HTML coordinates — for injecting
   * `data-html-wysiwyg-id` attrs into the served preview HTML. */
  composedOffsetMap: OffsetMap;
  /** The composed HTML (concatenated template-literal bodies, divider-separated). */
  composedHtml: string;
  /** Source ranges of template literals contributing to the composed HTML. */
  literals: readonly TemplateLiteralRange[];
  /** Composed → JS-source chunk map used for translation. */
  chunks: readonly ComposedChunk[];
}

/**
 * Extract HTML embedded in tagged template literals from a JS/TS source string,
 * walk it with the regular HTML walker, then translate every offset back to
 * coordinates in the original JS source. Elements/blocks/textNodes whose
 * offsets fall in synthetic dividers are dropped (they shouldn't occur in
 * practice; dividers are bare HTML comments).
 */
export function walkEditableInJs(
  source: string,
  documentVersion: number,
  options: WalkJsOptions = {},
): JsWalkResult {
  const literals = extractTemplateLiterals(source, options);
  const { composedHtml, chunks } = composeTemplateLiterals(literals);
  const composedMap = walkEditable(composedHtml, documentVersion, options);

  const droppedElementIds = new Set<number>();
  const elements: OffsetMap['elements'] = [];
  for (const el of composedMap.elements) {
    const startOffset = composedToSource(el.startOffset, chunks);
    const endOffset = composedToSource(el.endOffset, chunks);
    if (startOffset === null || endOffset === null) {
      droppedElementIds.add(el.elementId);
      continue;
    }
    elements.push({ ...el, startOffset, endOffset });
  }

  const droppedBlockIds = new Set<number>();
  const blocks: OffsetMap['blocks'] = [];
  for (const b of composedMap.blocks) {
    if (droppedElementIds.has(b.elementId)) {
      droppedBlockIds.add(b.blockId);
      continue;
    }
    const innerStart =
      b.innerStartOffset !== undefined
        ? composedToSource(b.innerStartOffset, chunks)
        : null;
    const innerEnd =
      b.innerEndOffset !== undefined
        ? composedToSource(b.innerEndOffset, chunks)
        : null;
    if (
      (b.innerStartOffset !== undefined && innerStart === null) ||
      (b.innerEndOffset !== undefined && innerEnd === null)
    ) {
      droppedBlockIds.add(b.blockId);
      continue;
    }
    blocks.push({
      ...b,
      innerStartOffset: innerStart === null ? undefined : innerStart,
      innerEndOffset: innerEnd === null ? undefined : innerEnd,
    });
  }

  const textNodes: OffsetMap['textNodes'] = [];
  for (const t of composedMap.textNodes) {
    if (droppedBlockIds.has(t.blockId)) continue;
    const startOffset = composedToSource(t.startOffset, chunks);
    const endOffset = composedToSource(t.endOffset, chunks);
    if (startOffset === null || endOffset === null) continue;
    textNodes.push({ ...t, startOffset, endOffset });
  }

  return {
    offsetMap: {
      type: 'offsetMap',
      documentVersion,
      elements,
      blocks,
      textNodes,
    },
    composedOffsetMap: composedMap,
    composedHtml,
    literals,
    chunks,
  };
}
