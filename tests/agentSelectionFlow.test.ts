import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { buildElementSourceReference } from '../src/host/agent/selection';
import { buildCursorElementPrompt } from '../src/host/agent/providers/cursor';
import { walkEditable } from '../src/host/parse/walkEditable';
import type { ElementSelectionSnapshot, ElementStyleSnapshot } from '../src/shared/protocol';

const EMPTY_STYLES: ElementStyleSnapshot = {
  inlineStyle: null,
  computed: {
    display: 'block',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
    borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(0, 0, 0)',
    borderTopLeftRadius: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    flexDirection: 'row', justifyContent: 'normal', alignItems: 'normal', flexWrap: 'nowrap',
    rowGap: 'normal',
    gridTemplateColumns: 'none', gridTemplateRows: 'none',
  },
};

function textDocument(source: string): vscode.TextDocument {
  return {
    getText: () => source,
    positionAt: (offset: number) => {
      const before = source.slice(0, offset);
      const lines = before.split('\n');
      return {
        line: lines.length - 1,
        character: lines[lines.length - 1].length,
      } as vscode.Position;
    },
  } as vscode.TextDocument;
}

describe('agent selected-element context flow', () => {
  it('turns a selected rendered element into source-backed Cursor agent context without running the SDK', () => {
    const source = [
      '<!doctype html>',
      '<html>',
      '  <body>',
      '    <section class="hero">',
      '      <h1>Launch faster</h1>',
      '      <button class="primary" aria-label="Start trial">Start trial</button>',
      '    </section>',
      '  </body>',
      '</html>',
    ].join('\n');
    const offsetMap = walkEditable(source, 7);
    const button = offsetMap.elements.find((e) => e.tagName === 'button');
    expect(button).toBeDefined();
    if (!button) return;

    const selection: ElementSelectionSnapshot = {
      documentVersion: 7,
      elementId: button.elementId,
      tagName: 'button',
      domPath: 'body > section > button',
      selectorHints: ['.primary', '[aria-label="Start trial"]'],
      textPreview: 'Start trial',
      outerHtmlPreview: '<button class="primary" aria-label="Start trial">Start trial</button>',
      rect: { x: 10, y: 20, width: 120, height: 32 },
      styles: EMPTY_STYLES,
    };

    const element = buildElementSourceReference({
      document: textDocument(source),
      relativePath: 'src/page.html',
      offsetMap,
      selection,
    });

    expect(element.workspaceRelativePath).toBe('src/page.html');
    expect(element.documentVersion).toBe(7);
    expect(element.elementId).toBe(button.elementId);
    expect(element.source).toBe(source.slice(button.startOffset, button.endOffset));
    expect(element.sourceHash).toHaveLength(64);
    expect(element.token).toContain('finesse-selection:src/page.html:7');

    const prompt = buildCursorElementPrompt({
      providerId: 'cursor',
      workspaceRoot: '/workspace',
      model: 'composer-2',
      userPrompt: 'Make this CTA blue and more prominent.',
      element,
    });

    expect(prompt).toContain('Make this CTA blue and more prominent.');
    expect(prompt).toContain('- File: src/page.html');
    expect(prompt).toContain(`- Source SHA-256: ${element.sourceHash}`);
    expect(prompt).toContain('<button class="primary" aria-label="Start trial">Start trial</button>');
    expect(prompt).toContain('Treat the source range and hash as the primary identity');
  });

  it('rejects stale selections before any agent provider can run', () => {
    const source = '<html><body><button>Go</button></body></html>';
    const offsetMap = walkEditable(source, 3);
    const button = offsetMap.elements.find((e) => e.tagName === 'button');
    expect(button).toBeDefined();
    if (!button) return;

    expect(() =>
      buildElementSourceReference({
        document: textDocument(source),
        relativePath: 'src/page.html',
        offsetMap,
        selection: {
          documentVersion: 2,
          elementId: button.elementId,
          tagName: 'button',
          domPath: 'body > button',
          selectorHints: [],
          textPreview: 'Go',
          outerHtmlPreview: '<button>Go</button>',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          styles: EMPTY_STYLES,
        },
      }),
    ).toThrow(/stale/i);
  });
});
