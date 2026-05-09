import { parse } from 'parse5';
import type { OffsetMap } from '../../shared/protocol';
import {
  AnyAttr,
  BLOCK_TAGS,
  NON_EDITABLE_PARENT_TAGS,
  SKIP_SUBTREE_TAGS,
  hasNoEditAttr,
  isEditAnywayOverride,
} from './editabilityRules';
import { textHasTemplateToken } from './templateDetect';

interface SourceLocation {
  startOffset: number;
  endOffset: number;
}

interface Parse5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: AnyAttr[];
  childNodes?: Parse5Node[];
  sourceCodeLocation?: SourceLocation;
}

function isElement(node: Parse5Node): boolean {
  return typeof node.tagName === 'string';
}

function isText(node: Parse5Node): boolean {
  return node.nodeName === '#text';
}

export interface WalkOptions {
  /** When true, ignore the templated-file file-level lock (the editAnyway override). */
  bypassFileTemplateLock?: boolean;
  /** Custom template token regexes; if any editable text node matches, it is locked. */
  templatePatterns?: readonly RegExp[];
}

export function walkEditable(
  html: string,
  documentVersion: number,
  options: WalkOptions = {},
): OffsetMap {
  const doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as Parse5Node;
  const blocks: OffsetMap['blocks'] = [];
  const textNodes: OffsetMap['textNodes'] = [];
  const blockIdByElement = new Map<Parse5Node, number>();
  let nextBlockId = 0;
  let nextNodeId = 0;
  let htmlElementOverride = false;

  function ensureBlockId(el: Parse5Node): number {
    const existing = blockIdByElement.get(el);
    if (existing !== undefined) return existing;
    const id = nextBlockId++;
    blockIdByElement.set(el, id);
    blocks.push({ blockId: id, tagName: el.tagName ?? '' });
    return id;
  }

  function findEnclosingBlock(blockAncestors: Parse5Node[]): Parse5Node | null {
    return blockAncestors.length > 0 ? blockAncestors[blockAncestors.length - 1] : null;
  }

  function visit(
    node: Parse5Node,
    blockAncestors: Parse5Node[],
    locked: boolean,
  ): void {
    if (isElement(node)) {
      const tag = node.tagName ?? '';
      if (tag === 'html' && isEditAnywayOverride(node.attrs)) {
        htmlElementOverride = true;
      }
      if (SKIP_SUBTREE_TAGS.has(tag)) return;
      if (NON_EDITABLE_PARENT_TAGS.has(tag)) return;
      const elLocked = locked || hasNoEditAttr(node.attrs);
      const nextBlocks = BLOCK_TAGS.has(tag) ? [...blockAncestors, node] : blockAncestors;
      for (const child of node.childNodes ?? []) {
        visit(child, nextBlocks, elLocked);
      }
    } else if (isText(node)) {
      if (locked) return;
      const text = node.value ?? '';
      if (!text || !text.trim()) return;
      const loc = node.sourceCodeLocation;
      if (!loc) return;
      const blockEl = findEnclosingBlock(blockAncestors);
      if (!blockEl) return;
      if (textHasTemplateToken(text, options.templatePatterns)) return;
      const blockId = ensureBlockId(blockEl);
      textNodes.push({
        nodeId: nextNodeId++,
        blockId,
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
        originalText: text,
      });
    }
  }

  for (const child of doc.childNodes ?? []) {
    visit(child, [], false);
  }

  // If file is templated and override not present, callers (Stream 1A) typically skip emitting
  // the offsetMap. We still return what we walked; the file-level lock is decided externally.
  void htmlElementOverride;

  return {
    type: 'offsetMap',
    documentVersion,
    blocks,
    textNodes,
  };
}

export function hasEditAnywayOverride(html: string): boolean {
  // Cheap regex pre-check; avoids a full parse just to check the override.
  const match = /<html(\s[^>]*)?>/i.exec(html);
  if (!match) return false;
  const attrPart = match[1] ?? '';
  return /\bdata-html-wysiwyg-allow\s*=\s*["']?true["']?/i.test(attrPart);
}
