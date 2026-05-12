import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeBlockHtmlSplices, applySplicesToSource } from '../src/host/computeBlockHtmlSplices';
import { computeBlockTagSplices } from '../src/host/blockTagTransform';
import { createEditTransaction, EditHistory, hashText } from '../src/host/editHistory';
import { walkEditable } from '../src/host/parse/walkEditable';
import { createPreviewServer, type PreviewServer } from '../src/host/server';
import type { SpliceOp } from '../src/host/undoStack';
import type { HostMessage, IframeMessage, OffsetMap } from '../src/shared/protocol';

const repoRoot = path.resolve(__dirname, '..');
const sourceFixturePath = path.join(repoRoot, 'fixtures/detailed-example.html');
const runtimeBundlePath = path.join(repoRoot, 'dist/iframe/runtime.js');

test('serves a copied detailed fixture with runtime instrumentation', async ({ page }) => {
  const harness = await createHarness(page);
  try {
    await page.goto(harness.url);

    await expect(page.locator('#page-title')).toHaveText('Acme Studio Launch Plan');
    await expect(page.locator('#lead-copy')).toHaveAttribute('data-finesse-id', /\d+/);
    await expect(page.locator('#overview')).toHaveAttribute('data-finesse-id', /\d+/);
    await expect(page.locator('#finesse-hover')).toBeAttached();
    await expect(page.locator('#finesse-selection')).toBeAttached();

    const ready = await waitForMessages(page, 'ready', 1);
    expect(ready[0]).toEqual({ type: 'ready' });
    expect(harness.copyExists()).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test('edits the copied source, saves it, validates the file, then cleans up', async ({ page }) => {
  const harness = await createHarness(page);
  const firstEdit = ' Updated in e2e.';
  const secondEdit = ' Saved from shortcut.';
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#lead-copy').click();
    await expect(page.locator('#lead-copy')).toBeFocused();
    await expect(page.locator('#lead-copy')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.type(firstEdit);
    await page.keyboard.press('Enter');

    await waitForMessages(page, 'editCommit', 1);
    await waitForMessages(page, 'editAck', 1);
    expect(harness.diskText()).not.toContain(firstEdit);

    await pressSaveShortcut(page);
    await waitForMessages(page, 'saveRequest', 1);
    await waitForMessages(page, 'documentState', 1);
    expect(harness.diskText()).toContain(firstEdit);

    await page.locator('#footer-copy').click();
    await expect(page.locator('#footer-copy')).toBeFocused();
    await expect(page.locator('#footer-copy')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.type(secondEdit);
    await pressSaveShortcut(page);

    await waitForMessages(page, 'editCommit', 2);
    await waitForMessages(page, 'editAck', 2);
    await waitForMessages(page, 'saveRequest', 2);
    await waitForMessages(page, 'documentState', 2);

    const saved = harness.diskText();
    expect(saved).toContain(firstEdit);
    expect(saved).toContain(secondEdit);
    expect(saved).toContain(
      '<!-- This comment is here to verify source preservation around edits. -->',
    );

    await pressUndoShortcut(page);
    await waitForMessages(page, 'undoRequest', 1);
    await waitForMessages(page, 'editAck', 3);
    await pressSaveShortcut(page);
    await waitForMessages(page, 'saveRequest', 3);

    const afterUndoSave = harness.diskText();
    expect(afterUndoSave).toContain(firstEdit);
    expect(afterUndoSave).not.toContain(secondEdit);

    await pressRedoShortcut(page);
    await waitForMessages(page, 'redoRequest', 1);
    await waitForMessages(page, 'editAck', 4);
    await pressSaveShortcut(page);
    await waitForMessages(page, 'saveRequest', 4);

    const afterRedoSave = harness.diskText();
    expect(afterRedoSave).toContain(firstEdit);
    expect(afterRedoSave).toContain(secondEdit);
  } finally {
    const copyPath = harness.copyPath;
    await harness.dispose();
    expect(fs.existsSync(copyPath)).toBe(false);
  }
});

test('disables undo and redo after stale history replay conflicts', async ({ page }) => {
  const harness = await createHarness(page);
  const editText = ' Conflict checked.';
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#lead-copy').click();
    await page.keyboard.type(editText);
    await page.keyboard.press('Enter');

    await waitForMessages(page, 'editCommit', 1);
    await waitForMessages(page, 'editAck', 1);
    const beforeConflict = await waitForMessages(page, 'documentState', 1);
    expect(beforeConflict.at(-1)).toMatchObject({ canUndo: true, canRedo: false });

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const win = window as Window & { __e2eSuppressReload?: boolean };
      win.__e2eSuppressReload = true;
    });
    harness.replaceSource((current) => current.replace('Acme Studio Launch Plan', 'External title'));

    await page.evaluate(() => window.postMessage({ type: 'undoRequest' }, '*'));
    await waitForMessages(page, 'undoRequest', 1);
    await waitForMessages(page, 'reload', 1);
    const afterConflict = await waitForMessages(page, 'documentState', 2);
    expect(afterConflict.at(-1)).toMatchObject({ canUndo: false, canRedo: false });
    expect(harness.currentText()).toContain(editText);
    expect(harness.currentText()).toContain('External title');
  } finally {
    await harness.dispose();
  }
});

test('keeps data-no-edit and preformatted regions out of text edit mode', async ({ page }) => {
  const harness = await createHarness(page);
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('.readonly-note').click();
    await expect(page.locator('.readonly-note')).not.toHaveAttribute('contenteditable', 'true');

    await page.locator('pre').click();
    await expect(page.locator('pre')).not.toHaveAttribute('contenteditable', 'true');
  } finally {
    await harness.dispose();
  }
});

test('selects an element and emits agent context without running an agent', async ({ page }) => {
  const harness = await createHarness(page);
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#lead-copy').click();

    const messages = await waitForMessages(page, 'elementSelectionChanged', 1);
    const message = messages[0] as Extract<IframeMessage, { type: 'elementSelectionChanged' }>;
    expect(message.selection).toBeTruthy();
    expect(message.selection?.documentVersion).toBe(1);
    expect(message.selection?.tagName).toBe('p');
    expect(message.selection?.textPreview).toContain('A detailed static HTML page');
    expect(message.selection?.outerHtmlPreview).toContain('id="lead-copy"');
    expect(message.selection?.selectorHints).toContain('#lead-copy');
    expect(message.selection?.domPath).toContain('body >');
    await expect(page.locator('#lead-copy')).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('#finesse-toolbar')).toHaveAttribute('data-visible', 'true');
    await expect(page.locator('#finesse-delete')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const win = window as Window & {
        __e2eMessages?: Array<{ type?: string; selection?: unknown }>;
      };
      return win.__e2eMessages?.some(
        (candidate) => candidate.type === 'elementSelectionChanged' && candidate.selection === null,
      );
    });
    await expect(page.locator('#lead-copy')).not.toBeFocused();
    await expect(page.locator('#finesse-selection')).not.toBeVisible();

    const allMessages = await page.evaluate(() => {
      const win = window as Window & { __e2eMessages?: Array<{ type?: string }> };
      return win.__e2eMessages ?? [];
    });
    expect(allMessages.some((candidate) => candidate.type === 'agentRunRequested')).toBe(false);
  } finally {
    await harness.dispose();
  }
});

test('selection exposes only same-document style rules as editable class rules', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/linked.css">
    <style>.local { color: red; }</style>
  </head>
  <body>
    <p id="copy" class="local external">Editable copy</p>
  </body>
</html>`,
    {
      'linked.css': '.external { color: blue; }',
    },
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#copy').click();

    const messages = await waitForMessages(page, 'elementSelectionChanged', 1);
    const message = messages[0] as Extract<IframeMessage, { type: 'elementSelectionChanged' }>;
    expect(message.selection?.classRules.local).toEqual([
      {
        selector: '.local',
        declarations: [{ property: 'color', value: 'red', important: false }],
      },
    ]);
    expect(message.selection?.classRules.external).toBeUndefined();
  } finally {
    await harness.dispose();
  }
});

test('CSS declaration edits use the refreshed iframe document version', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <head>
    <style>.local { color: red; }</style>
  </head>
  <body>
    <p id="copy" class="local">Editable copy</p>
  </body>
</html>`,
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    const offsetMap = await page.evaluate(() => {
      const win = window as Window & { __FINESSE__?: { offsetMap?: OffsetMap } };
      return win.__FINESSE__?.offsetMap;
    });
    expect(offsetMap).toBeTruthy();

    await page.evaluate((map) => {
      window.postMessage({ ...map, documentVersion: 2 }, '*');
    }, offsetMap);
    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'panelCssEdit',
          documentVersion: 1,
          selector: '.local',
          property: 'color',
          value: 'blue',
        },
        '*',
      );
    });

    const messages = await waitForMessages(page, 'editCssDeclaration', 1);
    expect(messages.at(-1)).toMatchObject({
      type: 'editCssDeclaration',
      documentVersion: 2,
      selector: '.local',
      property: 'color',
      value: 'blue',
    });
  } finally {
    await harness.dispose();
  }
});

test('forwards the command palette shortcut while the preview is focused', async ({ page }) => {
  const harness = await createHarness(page);
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#lead-copy').click();
    await expect(page.locator('#lead-copy')).toHaveAttribute('contenteditable', 'true');

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
    await waitForMessages(page, 'commandPaletteRequest', 1);
  } finally {
    await harness.dispose();
  }
});

test('select-all while editing selects only the active element text', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <body>
    <p id="copy">Original <strong>rich</strong> text</p>
    <p id="sibling">Sibling text</p>
  </body>
</html>`,
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#copy').click();
    await expect(page.locator('#copy')).toHaveAttribute('contenteditable', 'true');

    await pressSelectAllShortcut(page);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('Original rich text');

    await page.keyboard.type('Replacement text');
    await page.keyboard.press('Enter');
    await waitForMessages(page, 'editBlockHtml', 1);

    await expect(page.locator('#copy')).toHaveText('Replacement text');
    await expect(page.locator('#sibling')).toHaveText('Sibling text');
  } finally {
    await harness.dispose();
  }
});

test('block style select retags the active editable element', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <body>
    <p id="copy" class="lede">Original text</p>
    <p id="sibling">Sibling text</p>
  </body>
</html>`,
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#copy').click();
    await expect(page.locator('#copy')).toHaveAttribute('contenteditable', 'true');
    await page.locator('#finesse-toolbar select[aria-label="Block style"]').selectOption('h1');

    await expect(page.locator('h1#copy.lede')).toHaveText('Original text');
    await expect(page.locator('#copy')).toBeFocused();
    await expect(page.locator('#sibling')).toHaveText('Sibling text');

    await page.keyboard.press('Enter');
    await waitForMessages(page, 'editBlockTag', 1);
    await pressSaveShortcut(page);
    await waitForMessages(page, 'saveRequest', 1);

    expect(harness.diskText()).toContain('<h1 id="copy" class="lede">Original text</h1>');
    expect(harness.diskText()).toContain('<p id="sibling">Sibling text</p>');
  } finally {
    await harness.dispose();
  }
});

test('native-click bypass allows native clicks on interactive preview elements', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <body>
    <nav>
      <a id="jump-link" href="#target"><span>Jump</span></a>
      <button id="phase-button" data-phase="1b"><span>Phase 1B</span></button>
    </nav>
    <p id="copy">Editable copy</p>
    <details id="accordion">
      <summary><span>Open details</span></summary>
      <p>Accordion body</p>
    </details>
    <details id="readonly-accordion">
      <summary data-no-edit>Readonly details</summary>
      <p>Readonly accordion body</p>
    </details>
    <button id="low-button" style="position: fixed; left: 20px; bottom: -20px; height: 80px">
      <span>Low button</span>
    </button>
    <div style="height: 1200px"></div>
    <section id="target">Target</section>
    <script>
      document.addEventListener('click', (event) => {
        const target =
          event.target instanceof Element
            ? event.target
            : event.target?.parentNode instanceof Element
              ? event.target.parentNode
              : null;
        const button = target?.closest('#phase-button');
        if (button) document.body.dataset.phase = button.dataset.phase;
      });
      document.querySelector('#jump-link').addEventListener('click', (event) => {
        document.body.dataset.jump = event.defaultPrevented ? 'prevented' : 'clicked';
      });
    </script>
  </body>
</html>`,
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#accordion summary span').hover();
    await expect(page.locator('#finesse-native-click-hint')).toBeVisible();
    await expect(page.locator('#finesse-native-click-hint')).toContainText('V');
    await expect(page.locator('#finesse-native-click-hint')).toContainText('click');

    await page.locator('#low-button').hover();
    const lowHintPosition = await page.evaluate(() => {
      const hint = document.querySelector('#finesse-native-click-hint')?.getBoundingClientRect();
      const target = document.querySelector('#low-button')?.getBoundingClientRect();
      return hint && target
        ? {
            hintBottom: hint.bottom,
            hintLeft: hint.left,
            targetBottom: target.bottom,
            targetLeft: target.left,
            viewportHeight: window.innerHeight,
          }
        : null;
    });
    expect(lowHintPosition).toBeTruthy();
    expect(lowHintPosition!.targetBottom).toBeGreaterThan(lowHintPosition!.viewportHeight);
    expect(lowHintPosition!.hintBottom).toBeLessThanOrEqual(lowHintPosition!.viewportHeight - 7);
    expect(lowHintPosition!.hintLeft).toBeGreaterThanOrEqual(lowHintPosition!.targetLeft);
    expect(lowHintPosition!.hintLeft).toBeLessThan(lowHintPosition!.targetLeft + 16);

    await page.locator('#accordion summary span').click();
    await expect(page.locator('#accordion')).not.toHaveAttribute('open', '');
    await expect(page.locator('#accordion summary span')).toBeFocused();
    await expect(page.locator('#accordion summary span')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Escape');

    await page.locator('#readonly-accordion summary').click();
    await expect(page.locator('#readonly-accordion')).not.toHaveAttribute('open', '');

    await page.keyboard.down('v');
    await page.locator('#accordion summary span').click();
    await page.keyboard.up('v');
    await expect(page.locator('#accordion')).toHaveAttribute('open', '');
    await expect(page.locator('#accordion summary')).not.toHaveAttribute('contenteditable', 'true');

    await page.keyboard.down('v');
    await page.locator('#readonly-accordion summary').click();
    await page.keyboard.up('v');
    await expect(page.locator('#readonly-accordion')).toHaveAttribute('open', '');

    await page.locator('#phase-button span').click();
    await expect(page.locator('body')).not.toHaveAttribute('data-phase');
    await expect(page.locator('#phase-button span')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Escape');

    await page.locator('#phase-button span').click({ modifiers: ['Alt'] });
    await expect(page.locator('body')).not.toHaveAttribute('data-phase');
    await expect(page.locator('#phase-button span')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Escape');

    await page.keyboard.down('v');
    await page.locator('#phase-button span').click();
    await page.keyboard.up('v');
    await expect(page.locator('body')).toHaveAttribute('data-phase', '1b');

    await page.keyboard.down('v');
    await page.locator('#jump-link span').click();
    await page.keyboard.up('v');
    await expect(page.locator('body')).toHaveAttribute('data-jump', 'clicked');
    await expect(page.locator('#copy')).not.toHaveAttribute('contenteditable', 'true');
  } finally {
    await harness.dispose();
  }
});

test('edits nested text spans inside interactive controls', async ({ page }) => {
  const harness = await createHarness(
    page,
    `<!doctype html>
<html>
  <body>
    <button id="phase-button" class="nav-sub" data-phase="1c">
      <span class="num">1C</span>
      <span id="phase-name" class="name">Internal Engineering Rollout</span>
      <span id="remove-me" class="who-line">self-onboard</span>
    </button>
    <p id="plain-copy">Plain editable copy</p>
    <script>
      document.addEventListener('click', (event) => {
        const target =
          event.target instanceof Element
            ? event.target
            : event.target?.parentNode instanceof Element
              ? event.target.parentNode
              : null;
        const button = target?.closest('#phase-button');
        if (button) document.body.dataset.phase = button.dataset.phase;
      });
    </script>
  </body>
</html>`,
  );
  try {
    await page.goto(harness.url);
    await waitForMessages(page, 'ready', 1);

    await page.locator('#phase-name').click();
    await expect(page.locator('body')).not.toHaveAttribute('data-phase');
    await expect(page.locator('#phase-name')).toBeFocused();
    await expect(page.locator('#phase-name')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.insertText(' edited');
    await page.keyboard.press('Enter');
    await waitForMessages(page, 'editCommit', 1);
    await expect(page.locator('#phase-name')).toHaveText('Internal Engineering Rollout edited');
    await expect(page.locator('body')).not.toHaveAttribute('data-phase');

    await page.locator('#plain-copy').click();
    await expect(page.locator('#plain-copy')).toBeFocused();
    await expect(page.locator('#plain-copy')).toHaveAttribute('contenteditable', 'true');
    await page.keyboard.press('Escape');

    await page.locator('#remove-me').click();
    await expect(page.locator('body')).not.toHaveAttribute('data-phase');
    await expect(page.locator('#remove-me')).toBeFocused();
    await expect(page.locator('#remove-me')).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('#finesse-toolbar')).toHaveAttribute('data-visible', 'true');
    await expect(page.locator('#finesse-toolbar button[aria-label="Delete element"]')).toBeVisible();
    await page.locator('#finesse-toolbar button[aria-label="Delete element"]').click();
    await waitForMessages(page, 'editRemove', 1);
    await expect(page.locator('#remove-me')).toHaveCount(0);
  } finally {
    await harness.dispose();
  }
});

interface Harness {
  copyPath: string;
  url: string;
  copyExists(): boolean;
  currentText(): string;
  diskText(): string;
  replaceSource(update: (current: string) => string): void;
  dispose(): Promise<void>;
}

async function createHarness(
  page: Page,
  sourceHtml?: string,
  extraFiles: Record<string, string> = {},
): Promise<Harness> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finesse-e2e-'));
  const relativePath = 'detailed-example.html';
  const copyPath = path.join(workspaceRoot, relativePath);
  if (sourceHtml === undefined) fs.copyFileSync(sourceFixturePath, copyPath);
  else fs.writeFileSync(copyPath, sourceHtml);
  for (const [relativeFilePath, contents] of Object.entries(extraFiles)) {
    const filePath = path.join(workspaceRoot, relativeFilePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  let source = fs.readFileSync(copyPath, 'utf-8');
  let version = 1;
  let offsetMap = walkEditable(source, version);
  let dirty = false;
  let nextEditTransactionId = 1;
  const editHistory = new EditHistory();

  const server = createPreviewServer({
    workspaceRoot,
    port: 'auto',
    runtimeBundlePath,
    getDocumentText: (workspaceRelativePath) =>
      workspaceRelativePath === relativePath ? source : null,
    getInjectedPreviewHtml: () => null,
    getOffsetMap: (workspaceRelativePath) =>
      workspaceRelativePath === relativePath ? offsetMap : null,
    isTemplated: () => false,
  });

  await page.exposeBinding(
    '__finesseHostMessage',
    async (_bindingSource, message: IframeMessage) => {
      const responses = applyIframeMessage(message);
      for (const response of responses) {
        await page.evaluate((msg) => window.postMessage(msg, '*'), response);
      }
    },
  );
  await installMessageRecorder(page);

  const port = await server.start();

  function applyIframeMessage(message: IframeMessage): HostMessage[] {
    switch (message.type) {
      case 'editCommit': {
        const sourceBefore = source;
        const result = applyTextEdit(source, offsetMap, message);
        recordEditTransaction('Text edit', sourceBefore, result.source, result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editBlockHtml': {
        const sourceBefore = source;
        const result = applyBlockHtmlEdit(source, offsetMap, message);
        recordEditTransaction('Block HTML edit', sourceBefore, result.source, result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editBlockTag': {
        const sourceBefore = source;
        const result = applyBlockTagEdit(source, offsetMap, message);
        recordEditTransaction('Tag edit', sourceBefore, result.source, result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editRemove': {
        const sourceBefore = source;
        const result = applyRemoveEdit(source, offsetMap, message);
        recordEditTransaction('Remove element', sourceBefore, result.source, result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'saveRequest':
        fs.writeFileSync(copyPath, source);
        dirty = false;
        return [documentState()];
      case 'undoRequest': {
        const op = editHistory.beginUndo();
        if (!op) return [documentState()];
        const entry = op.transaction;
        if (hashText(source) !== entry.sourceHashAfter) {
          op.abort();
          editHistory.markExternalConflict('stale-replay');
          return [{ type: 'reload', reason: 'stale-commit' }, documentState()];
        }
        source = applySplices(source, op.splices);
        op.commit();
        return acknowledgeEdit();
      }
      case 'redoRequest': {
        const op = editHistory.beginRedo();
        if (!op) return [documentState()];
        const entry = op.transaction;
        if (hashText(source) !== entry.sourceHashBefore) {
          op.abort();
          editHistory.markExternalConflict('stale-replay');
          return [{ type: 'reload', reason: 'stale-commit' }, documentState()];
        }
        source = applySplices(source, op.splices);
        op.commit();
        return acknowledgeEdit();
      }
      default:
        return [];
    }
  }

  function recordEditTransaction(
    label: string,
    sourceBefore: string,
    sourceAfter: string,
    forward: SpliceOp[],
  ): void {
    if (forward.length === 0) return;
    editHistory.record(
      createEditTransaction({
        id: String(nextEditTransactionId++),
        label,
        sourceBefore,
        sourceAfter,
        forward,
        versionBefore: version,
        versionAfter: version + 1,
      }),
    );
  }

  function replaceSource(update: (current: string) => string): void {
    source = update(source);
    version += 1;
    offsetMap = walkEditable(source, version);
    dirty = true;
  }

  function acknowledgeEdit(): HostMessage[] {
    dirty = true;
    version += 1;
    offsetMap = walkEditable(source, version);
    return [{ type: 'editAck', documentVersion: version, offsetMap }, documentState()];
  }

  function documentState(): HostMessage {
    return {
      type: 'documentState',
      isDirty: dirty,
      canUndo: editHistory.canUndo(),
      canRedo: editHistory.canRedo(),
    };
  }

  return {
    copyPath,
    url: `http://127.0.0.1:${port}/${relativePath}`,
    copyExists: () => fs.existsSync(copyPath),
    currentText: () => source,
    diskText: () => fs.readFileSync(copyPath, 'utf-8'),
    replaceSource,
    async dispose() {
      await server.stop();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function installMessageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as Window & {
      __e2eMessages?: unknown[];
      __e2eSuppressReload?: boolean;
      __finesseHostMessage?: (message: unknown) => Promise<void>;
    };
    win.__e2eMessages = [];
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      win.__e2eMessages?.push(data);
      if (data.type === 'reload' && win.__e2eSuppressReload) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
      if (isIframeToHostMessage(data.type)) {
        void win.__finesseHostMessage?.(data);
      }
    });

    function isIframeToHostMessage(type: string): boolean {
      return (
        type === 'editCommit' ||
        type === 'editBlockHtml' ||
        type === 'editBlockTag' ||
        type === 'editRemove' ||
        type === 'saveRequest' ||
        type === 'undoRequest' ||
        type === 'redoRequest' ||
        type === 'commandPaletteRequest'
      );
    }
  });
}

async function waitForMessages(page: Page, type: string, count: number): Promise<unknown[]> {
  await page.waitForFunction(
    ({ messageType, expectedCount }) => {
      const win = window as Window & { __e2eMessages?: Array<{ type?: string }> };
      return (
        (win.__e2eMessages?.filter((message) => message.type === messageType).length ?? 0) >=
        expectedCount
      );
    },
    { messageType: type, expectedCount: count },
  );
  return page.evaluate((messageType) => {
    const win = window as Window & { __e2eMessages?: Array<{ type?: string }> };
    return win.__e2eMessages?.filter((message) => message.type === messageType) ?? [];
  }, type);
}

async function pressSaveShortcut(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
}

async function pressUndoShortcut(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
}

async function pressRedoShortcut(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Shift+Z');
}

async function pressSelectAllShortcut(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
}

interface SourceApplyResult {
  source: string;
  forward: SpliceOp[];
}

function applyTextEdit(
  source: string,
  offsetMap: OffsetMap,
  message: Extract<IframeMessage, { type: 'editCommit' }>,
): SourceApplyResult {
  assertFresh(offsetMap, message.documentVersion);
  const textNodeById = new Map(offsetMap.textNodes.map((node) => [node.nodeId, node]));
  const forward: SpliceOp[] = message.edits.map((edit) => {
    const textNode = textNodeById.get(edit.nodeId);
    if (!textNode) throw new Error(`Unknown text node id: ${edit.nodeId}`);
    return {
      startOffset: textNode.startOffset,
      endOffset: textNode.endOffset,
      replacement: edit.newText,
    };
  });
  return { source: applySplices(source, forward), forward };
}

function applyBlockHtmlEdit(
  source: string,
  offsetMap: OffsetMap,
  message: Extract<IframeMessage, { type: 'editBlockHtml' }>,
): SourceApplyResult {
  assertFresh(offsetMap, message.documentVersion);
  const result = computeBlockHtmlSplices({
    source,
    offsetMap,
    blockId: message.blockId,
    newInnerHtml: message.newInnerHtml,
    newTagName: message.newTagName,
  });
  if (!result.ok) throw new Error(`Unable to apply block HTML edit: ${result.reason}`);
  const forward = result.splices.map((splice) => ({ ...splice }));
  return { source: applySplicesToSource(source, forward), forward };
}

function applyBlockTagEdit(
  source: string,
  offsetMap: OffsetMap,
  message: Extract<IframeMessage, { type: 'editBlockTag' }>,
): SourceApplyResult {
  assertFresh(offsetMap, message.documentVersion);
  const block = offsetMap.blocks.find((candidate) => candidate.blockId === message.blockId);
  const element = block
    ? offsetMap.elements.find((candidate) => candidate.elementId === block.elementId)
    : undefined;
  if (!block || !element) throw new Error(`Unknown block id: ${message.blockId}`);
  const splices = computeBlockTagSplices({
    source,
    elementStart: element.startOffset,
    elementEnd: element.endOffset,
    innerStart: block.innerStartOffset,
    innerEnd: block.innerEndOffset,
    oldTag: block.tagName,
    newTag: message.newTagName,
  });
  if (!splices) throw new Error(`Unable to apply block tag edit: ${message.newTagName}`);
  const forward = splices.map((splice) => ({ ...splice }));
  return { source: applySplices(source, forward), forward };
}

function applyRemoveEdit(
  source: string,
  offsetMap: OffsetMap,
  message: Extract<IframeMessage, { type: 'editRemove' }>,
): SourceApplyResult {
  assertFresh(offsetMap, message.documentVersion);
  const elementById = new Map(offsetMap.elements.map((element) => [element.elementId, element]));
  const forward: SpliceOp[] = message.elementIds.map((elementId) => {
    const element = elementById.get(elementId);
    if (!element) throw new Error(`Unknown element id: ${elementId}`);
    const expanded = expandRangeToTrimWhitespace(source, element.startOffset, element.endOffset);
    return { ...expanded, replacement: '' };
  });
  return { source: applySplices(source, forward), forward };
}

function applySplices(source: string, splices: readonly SpliceOp[]): string {
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  return applySplicesToSource(source, ordered);
}

function assertFresh(offsetMap: OffsetMap, documentVersion: number): void {
  if (offsetMap.documentVersion !== documentVersion) {
    throw new Error(
      `Stale commit: expected version ${offsetMap.documentVersion}, received ${documentVersion}`,
    );
  }
}

function expandRangeToTrimWhitespace(
  source: string,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } {
  let i = startOffset - 1;
  while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
  if (i >= 0 && source[i] === '\n') return { startOffset: i, endOffset };
  if (i >= 1 && source[i] === '\n' && source[i - 1] === '\r') {
    return { startOffset: i - 1, endOffset };
  }
  return { startOffset, endOffset };
}
