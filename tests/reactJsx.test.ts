import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

function locForPath(sourcePathForLoc: string, source: string, needle: string): string {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return `${sourcePathForLoc}:${lines.length}:${lines.at(-1)!.length}`;
}

function createWorkspace(files: Record<string, string>): {
  root: string;
  dispose(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finesse-react-jsx-'));
  for (const [relPath, source] of Object.entries(files)) {
    const filePath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  return {
    root,
    dispose(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
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

  it('resolves jsx-loc paths from a nested Next app root in a monorepo workspace', () => {
    const source = 'export default function Page() {\n  return <main><h1>Control Plane</h1></main>;\n}\n';
    const workspace = createWorkspace({
      'front-end/next.config.ts': 'export default {};\n',
      'front-end/package.json': '{"dependencies":{"next":"16.2.6","react":"19.2.4"},"devDependencies":{"jsx-loc-plugin":"0.2.157"}}\n',
      'front-end/src/app/page.tsx': source,
    });
    try {
      const map = buildReactOffsetMap({
        workspaceRoot: workspace.root,
        previewPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentText: '',
        activeDocumentVersion: 1,
        discoveries: [
          {
            elementId: 0,
            loc: locForPath('src/app/page.tsx', source, '<main'),
            tagName: 'main',
            occurrence: 0,
          },
          {
            elementId: 1,
            loc: locForPath('src/app/page.tsx', source, '<h1'),
            tagName: 'h1',
            occurrence: 0,
          },
        ],
      });

      expect(map.elements.map((e) => e.sourcePath)).toEqual([
        'front-end/src/app/page.tsx',
        'front-end/src/app/page.tsx',
      ]);
      expect(map.textNodes).toHaveLength(1);
      expect(map.textNodes[0].sourcePath).toBe('front-end/src/app/page.tsx');
    } finally {
      workspace.dispose();
    }
  });

  it('uses the nested app root that resolves the most discovered jsx-loc files', () => {
    const appSource = 'export function App() {\n  return <main>Dashboard</main>;\n}\n';
    const headerSource = 'export function Header() {\n  return <header>Header</header>;\n}\n';
    const workspace = createWorkspace({
      'apps/admin/next.config.ts': 'export default {};\n',
      'apps/admin/src/App.tsx': appSource,
      'apps/web/next.config.ts': 'export default {};\n',
      'apps/web/src/App.tsx': appSource,
      'apps/web/src/Header.tsx': headerSource,
    });
    try {
      const map = buildReactOffsetMap({
        workspaceRoot: workspace.root,
        previewPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentText: '',
        activeDocumentVersion: 1,
        discoveries: [
          {
            elementId: 0,
            loc: locForPath('src/App.tsx', appSource, '<main'),
            tagName: 'main',
            occurrence: 0,
          },
          {
            elementId: 1,
            loc: locForPath('src/Header.tsx', headerSource, '<header'),
            tagName: 'header',
            occurrence: 0,
          },
        ],
      });

      expect(map.elements.map((e) => e.sourcePath)).toEqual([
        'apps/web/src/App.tsx',
        'apps/web/src/Header.tsx',
      ]);
    } finally {
      workspace.dispose();
    }
  });

  it('locks an ambiguous nested jsx-loc source instead of guessing a package', () => {
    const source = 'export function App() {\n  return <main>Dashboard</main>;\n}\n';
    const workspace = createWorkspace({
      'apps/admin/next.config.ts': 'export default {};\n',
      'apps/admin/src/App.tsx': source,
      'apps/web/next.config.ts': 'export default {};\n',
      'apps/web/src/App.tsx': source,
    });
    try {
      const map = buildReactOffsetMap({
        workspaceRoot: workspace.root,
        previewPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentPath: '__finesse_dev_server__/preview.tsx',
        activeDocumentText: '',
        activeDocumentVersion: 1,
        discoveries: [
          {
            elementId: 0,
            loc: locForPath('src/App.tsx', source, '<main'),
            tagName: 'main',
            occurrence: 0,
          },
        ],
      });

      expect(map.elements).toHaveLength(0);
      expect(map.react?.locks).toEqual([{ elementId: 0, reason: 'missing-source-file' }]);
    } finally {
      workspace.dispose();
    }
  });
});
