import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from '@babel/parser';
import type { OffsetMap, ReactDomDiscovery, ReactEditLockReason } from '../../shared/protocol';
import { BLOCK_TAGS } from './editabilityRules';

type AnyNode = Record<string, any>;

const SKIP_ELEMENTS: ReadonlySet<string> = new Set([
  'Fragment',
  'React.Fragment',
  'Suspense',
  'React.Suspense',
  'StrictMode',
  'React.StrictMode',
  'Profiler',
  'React.Profiler',
]);

export interface BuildReactOffsetMapOptions {
  workspaceRoot: string;
  previewPath: string;
  activeDocumentPath: string;
  activeDocumentText: string;
  activeDocumentVersion: number;
  discoveries: ReadonlyArray<ReactDomDiscovery['elements'][number]>;
  readOpenDocument?: (workspaceRelativePath: string) => { text: string; version: number } | null;
}

interface SourceIndex {
  sourcePath: string;
  source: string;
  version: number;
  byLoc: Map<string, SourceElement>;
}

interface SourceElement {
  sourcePath: string;
  locKey: string;
  tagName: string;
  startOffset: number;
  endOffset: number;
  openNameStartOffset: number;
  openNameEndOffset: number;
  closeNameStartOffset?: number;
  closeNameEndOffset?: number;
  openingEndOffset: number;
  innerStartOffset?: number;
  innerEndOffset?: number;
  staticInner: boolean;
  attrs: SourceAttr[];
  textRanges: SourceTextRange[];
}

interface SourceAttr {
  name: string;
  startOffset: number;
  endOffset: number;
  valueStartOffset?: number;
  valueEndOffset?: number;
  kind: 'string' | 'expression' | 'bare';
}

interface SourceTextRange {
  startOffset: number;
  endOffset: number;
  originalText: string;
}

export function buildReactOffsetMap(opts: BuildReactOffsetMapOptions): OffsetMap {
  const sourceCache = new Map<string, SourceIndex | null>();
  const locCounts = new Map<string, number>();
  for (const d of opts.discoveries) {
    locCounts.set(d.loc, (locCounts.get(d.loc) ?? 0) + 1);
  }

  const elements: OffsetMap['elements'] = [];
  const blocks: OffsetMap['blocks'] = [];
  const textNodes: OffsetMap['textNodes'] = [];
  const reactElements: NonNullable<OffsetMap['react']>['elements'] = [];
  const reactBlocks: NonNullable<OffsetMap['react']>['blocks'] = [];
  const reactTextNodes: NonNullable<OffsetMap['react']>['textNodes'] = [];
  const lockedElementIds: number[] = [];
  const locks: NonNullable<OffsetMap['react']>['locks'] = [];
  let nextBlockId = 0;
  let nextNodeId = 0;

  for (const d of opts.discoveries) {
    const parsed = parseLocValue(d.loc, opts.workspaceRoot);
    if (!parsed) {
      lock(d.elementId, 'missing-source-file');
      continue;
    }
    const index = getSourceIndex(parsed.sourcePath);
    const sourceEl = index?.byLoc.get(parsed.locKey);
    if (!index || !sourceEl) {
      lock(d.elementId, 'missing-source-file');
      continue;
    }
    const repeated = (locCounts.get(d.loc) ?? 0) > 1;
    if (repeated) lock(d.elementId, 'repeated-source-instance');

    elements.push({
      elementId: d.elementId,
      tagName: d.tagName.toLowerCase(),
      startOffset: sourceEl.startOffset,
      endOffset: sourceEl.endOffset,
      sourcePath: sourceEl.sourcePath,
    });
    reactElements.push({
      elementId: d.elementId,
      sourcePath: sourceEl.sourcePath,
      openNameStartOffset: sourceEl.openNameStartOffset,
      openNameEndOffset: sourceEl.openNameEndOffset,
      closeNameStartOffset: sourceEl.closeNameStartOffset,
      closeNameEndOffset: sourceEl.closeNameEndOffset,
      openingEndOffset: sourceEl.openingEndOffset,
      innerStartOffset: sourceEl.innerStartOffset,
      innerEndOffset: sourceEl.innerEndOffset,
      attributes: sourceEl.attrs,
    });

    if (!repeated && BLOCK_TAGS.has(d.tagName.toLowerCase()) && sourceEl.innerStartOffset !== undefined) {
      const blockId = nextBlockId++;
      blocks.push({
        blockId,
        elementId: d.elementId,
        tagName: d.tagName.toLowerCase(),
        innerStartOffset: sourceEl.innerStartOffset,
        innerEndOffset: sourceEl.innerEndOffset,
        sourcePath: sourceEl.sourcePath,
      });
      reactBlocks.push({ blockId, sourcePath: sourceEl.sourcePath, staticInner: sourceEl.staticInner });
      if (sourceEl.staticInner) {
        for (const t of sourceEl.textRanges) {
          textNodes.push({
            nodeId: nextNodeId,
            blockId,
            startOffset: t.startOffset,
            endOffset: t.endOffset,
            originalText: t.originalText,
            sourcePath: sourceEl.sourcePath,
          });
          reactTextNodes.push({ nodeId: nextNodeId, sourcePath: sourceEl.sourcePath });
          nextNodeId++;
        }
      }
    }
  }

  return {
    type: 'offsetMap',
    path: opts.previewPath,
    documentVersion: opts.activeDocumentVersion,
    elements,
    blocks,
    textNodes,
    react: {
      mode: 'react',
      lockedElementIds,
      locks,
      elements: reactElements,
      blocks: reactBlocks,
      textNodes: reactTextNodes,
    },
  };

  function lock(elementId: number, reason: ReactEditLockReason): void {
    if (!lockedElementIds.includes(elementId)) lockedElementIds.push(elementId);
    locks.push({ elementId, reason });
  }

  function getSourceIndex(sourcePath: string): SourceIndex | null {
    const cached = sourceCache.get(sourcePath);
    if (cached !== undefined) return cached;
    let text: string | null = null;
    let version = 1;
    if (sourcePath === opts.activeDocumentPath) {
      text = opts.activeDocumentText;
      version = opts.activeDocumentVersion;
    } else {
      const open = opts.readOpenDocument?.(sourcePath);
      if (open) {
        text = open.text;
        version = open.version;
      } else {
        const abs = path.resolve(opts.workspaceRoot, sourcePath);
        try {
          text = fs.readFileSync(abs, 'utf-8');
        } catch {
          text = null;
        }
      }
    }
    const index = text === null ? null : indexJsxSource(text, sourcePath, version);
    sourceCache.set(sourcePath, index);
    return index;
  }
}

function indexJsxSource(source: string, sourcePath: string, version: number): SourceIndex {
  const byLoc = new Map<string, SourceElement>();
  let ast: AnyNode;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'asyncGenerators',
        'dynamicImport',
        'importMeta',
        'topLevelAwait',
      ],
      errorRecovery: true,
    }) as AnyNode;
  } catch {
    return { sourcePath, source, version, byLoc };
  }

  walk(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const opening = node.openingElement as AnyNode | undefined;
    if (!opening) return;
    const elementName = getElementName(opening.name);
    if (!elementName || SKIP_ELEMENTS.has(elementName)) return;
    const loc = opening.loc?.start;
    if (!loc || typeof opening.start !== 'number' || typeof node.end !== 'number') return;
    const locKey = `${sourcePath}:${loc.line}:${loc.column}`;
    byLoc.set(locKey, {
      sourcePath,
      locKey,
      tagName: elementName,
      startOffset: opening.start,
      endOffset: node.end,
      openNameStartOffset: opening.name?.start ?? opening.start + 1,
      openNameEndOffset: opening.name?.end ?? opening.start + 1,
      closeNameStartOffset: node.closingElement?.name?.start,
      closeNameEndOffset: node.closingElement?.name?.end,
      openingEndOffset: opening.end,
      innerStartOffset: opening.end,
      innerEndOffset: node.closingElement?.start ?? opening.end,
      staticInner: isStaticInner(node),
      attrs: getAttributes(opening),
      textRanges: getTextRanges(node),
    });
  });
  void version;
  return { sourcePath, source, version, byLoc };
}

function getAttributes(opening: AnyNode): SourceAttr[] {
  const attrs: SourceAttr[] = [];
  for (const attr of opening.attributes ?? []) {
    if (attr.type !== 'JSXAttribute') continue;
    const name = getAttrName(attr.name);
    if (!name || typeof attr.start !== 'number' || typeof attr.end !== 'number') continue;
    if (!attr.value) {
      attrs.push({ name, startOffset: attr.start, endOffset: attr.end, kind: 'bare' });
      continue;
    }
    if (attr.value.type === 'StringLiteral') {
      attrs.push({
        name,
        startOffset: attr.start,
        endOffset: attr.end,
        valueStartOffset: attr.value.start + 1,
        valueEndOffset: attr.value.end - 1,
        kind: 'string',
      });
      continue;
    }
    attrs.push({ name, startOffset: attr.start, endOffset: attr.end, kind: 'expression' });
  }
  return attrs;
}

function getTextRanges(node: AnyNode): SourceTextRange[] {
  const out: SourceTextRange[] = [];
  for (const child of node.children ?? []) {
    if (child.type !== 'JSXText') continue;
    const raw = child.value ?? '';
    if (!raw.trim()) continue;
    if (raw !== raw.trim()) continue;
    if (typeof child.start !== 'number' || typeof child.end !== 'number') continue;
    out.push({ startOffset: child.start, endOffset: child.end, originalText: raw });
  }
  return out;
}

function isStaticInner(node: AnyNode): boolean {
  for (const child of node.children ?? []) {
    if (child.type === 'JSXText') continue;
    if (child.type === 'JSXElement') continue;
    return false;
  }
  return true;
}

function getElementName(name: AnyNode | undefined): string | null {
  if (!name) return null;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const object = getElementName(name.object);
    const property = getElementName(name.property);
    return object && property ? `${object}.${property}` : null;
  }
  if (name.type === 'JSXNamespacedName') {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return null;
}

function getAttrName(name: AnyNode | undefined): string | null {
  if (!name) return null;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return null;
}

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}

function parseLocValue(value: string, workspaceRoot: string): { sourcePath: string; locKey: string } | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const rawPath = match[1];
  const line = Number.parseInt(match[2], 10);
  const column = Number.parseInt(match[3], 10);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  let sourcePath = rawPath.replace(/\\/g, '/');
  if (path.isAbsolute(sourcePath)) {
    const rel = path.relative(workspaceRoot, sourcePath).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    sourcePath = rel;
  }
  const abs = path.resolve(workspaceRoot, sourcePath);
  const within = path.relative(workspaceRoot, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  const normalized = sourcePath.replace(/^\/+/, '');
  return { sourcePath: normalized, locKey: `${normalized}:${line}:${column}` };
}
