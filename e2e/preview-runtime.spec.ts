import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeBlockHtmlSplices, applySplicesToSource } from '../src/host/computeBlockHtmlSplices';
import { computeBlockTagSplices } from '../src/host/blockTagTransform';
import { walkEditable } from '../src/host/parse/walkEditable';
import { createPreviewServer, type PreviewServer } from '../src/host/server';
import { computeInverseSplices, UndoStack, type SpliceOp } from '../src/host/undoStack';
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

    const allMessages = await page.evaluate(() => {
      const win = window as Window & { __e2eMessages?: Array<{ type?: string }> };
      return win.__e2eMessages ?? [];
    });
    expect(allMessages.some((candidate) => candidate.type === 'agentRunRequested')).toBe(false);
  } finally {
    await harness.dispose();
  }
});

interface Harness {
  copyPath: string;
  url: string;
  copyExists(): boolean;
  diskText(): string;
  dispose(): Promise<void>;
}

async function createHarness(page: Page): Promise<Harness> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finesse-e2e-'));
  const relativePath = 'detailed-example.html';
  const copyPath = path.join(workspaceRoot, relativePath);
  fs.copyFileSync(sourceFixturePath, copyPath);

  let source = fs.readFileSync(copyPath, 'utf-8');
  let version = 1;
  let offsetMap = walkEditable(source, version);
  let dirty = false;
  const undoStack = new UndoStack();

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
        const result = applyTextEdit(source, offsetMap, message);
        recordForwardEdit(result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editBlockHtml': {
        const result = applyBlockHtmlEdit(source, offsetMap, message);
        recordForwardEdit(result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editBlockTag': {
        const result = applyBlockTagEdit(source, offsetMap, message);
        recordForwardEdit(result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'editRemove': {
        const result = applyRemoveEdit(source, offsetMap, message);
        recordForwardEdit(result.forward);
        source = result.source;
        return acknowledgeEdit();
      }
      case 'saveRequest':
        fs.writeFileSync(copyPath, source);
        dirty = false;
        return [documentState()];
      case 'undoRequest': {
        const entry = undoStack.popUndo();
        if (!entry) return [documentState()];
        source = applySplices(source, entry.inverse);
        undoStack.pushRedo(entry);
        return acknowledgeEdit();
      }
      case 'redoRequest': {
        const entry = undoStack.popRedo();
        if (!entry) return [documentState()];
        source = applySplices(source, entry.forward);
        undoStack.pushUndo(entry);
        return acknowledgeEdit();
      }
      default:
        return [];
    }
  }

  function recordForwardEdit(forward: SpliceOp[]): void {
    if (forward.length === 0) return;
    undoStack.push({
      forward,
      inverse: computeInverseSplices(source, forward),
      versionBefore: version,
      versionAfter: version + 1,
    });
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
      autoSave: false,
      canUndo: undoStack.canUndo(),
      canRedo: undoStack.canRedo(),
    };
  }

  return {
    copyPath,
    url: `http://127.0.0.1:${port}/${relativePath}`,
    copyExists: () => fs.existsSync(copyPath),
    diskText: () => fs.readFileSync(copyPath, 'utf-8'),
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
      __finesseHostMessage?: (message: unknown) => Promise<void>;
    };
    win.__e2eMessages = [];
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      win.__e2eMessages?.push(data);
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
        type === 'redoRequest'
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
