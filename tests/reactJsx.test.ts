import { describe, expect, it } from 'vitest';
import { buildReactOffsetMap } from '../src/host/parse/reactJsx';
import {
  computeReactAttrEditSplices,
  computeReactBlockHtmlSplices,
  computeReactBlockTagSplices,
  computeReactRemoveSplices,
} from '../src/host/computeReactEditSplices';
import { applySplicesToSource } from '../src/host/computeBlockHtmlSplices';

const workspaceRoot = '/workspace';
const sourcePath = 'src/App.tsx';

function locFor(source: string, needle: string): string {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return `${sourcePath}:${lines.length}:${lines.at(-1)!.length}`;
}

function mapFor(source: string, needles: string[]) {
  return buildReactOffsetMap({
    workspaceRoot,
    previewPath: sourcePath,
    activeDocumentPath: sourcePath,
    activeDocumentText: source,
    activeDocumentVersion: 7,
    discoveries: needles.map((needle, i) => ({
      elementId: i,
      loc: locFor(source, needle),
      tagName: needle.slice(1).split(/[ >]/)[0],
      occurrence: 0,
    })),
  });
}

describe('React JSX offset maps', () => {
  it('maps jsx-loc data back to JSX source offsets', () => {
    const source = 'export function App() {\n  return <div className="hero"><p>Hello</p></div>;\n}\n';
    const map = mapFor(source, ['<div', '<p']);
    expect(map.react?.mode).toBe('react');
    expect(map.elements.map((e) => e.tagName)).toEqual(['div', 'p']);
    expect(map.textNodes).toHaveLength(1);
    const text = map.textNodes[0];
    expect(source.slice(text.startOffset, text.endOffset)).toBe('Hello');
  });

  it('locks repeated rendered instances from the same JSX source', () => {
    const source = 'export function Item() {\n  return <p>Hello</p>;\n}\n';
    const loc = locFor(source, '<p');
    const map = buildReactOffsetMap({
      workspaceRoot,
      previewPath: sourcePath,
      activeDocumentPath: sourcePath,
      activeDocumentText: source,
      activeDocumentVersion: 1,
      discoveries: [
        { elementId: 0, loc, tagName: 'p', occurrence: 0 },
        { elementId: 1, loc, tagName: 'p', occurrence: 1 },
      ],
    });
    expect(map.react?.lockedElementIds).toEqual([0, 1]);
    expect(map.blocks).toHaveLength(0);
  });

  it('computes safe JSX text, block, tag, attr, and remove splices', () => {
    const source = 'export function App() {\n  return <div className="hero"><p>Hello</p></div>;\n}\n';
    const map = mapFor(source, ['<div', '<p']);

    const attr = computeReactAttrEditSplices({
      offsetMap: map,
      commit: { type: 'editElementAttrs', documentVersion: 7, elementId: 0, attrs: { class: 'lede' } },
    });
    expect(attr.ok && applySplicesToSource(source, attr.splices)).toContain('className="lede"');

    const block = map.blocks.find((b) => b.tagName === 'p')!;
    const html = computeReactBlockHtmlSplices({
      offsetMap: map,
      commit: { type: 'editBlockHtml', documentVersion: 7, blockId: block.blockId, newInnerHtml: '<strong>Hi</strong>' },
    });
    expect(html.ok && applySplicesToSource(source, html.splices)).toContain('<p><strong>Hi</strong></p>');

    const tag = computeReactBlockTagSplices({
      offsetMap: map,
      commit: { type: 'editBlockTag', documentVersion: 7, blockId: block.blockId, newTagName: 'h2' },
    });
    expect(tag.ok && applySplicesToSource(source, tag.splices)).toContain('<h2>Hello</h2>');

    const remove = computeReactRemoveSplices({
      offsetMap: map,
      commit: { type: 'editRemove', documentVersion: 7, elementIds: [1] },
    });
    expect(remove.ok && applySplicesToSource(source, remove.splices)).toContain('<div className="hero"></div>');
  });
});
