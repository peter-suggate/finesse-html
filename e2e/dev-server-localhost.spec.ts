import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPreviewServer, type PreviewServer } from '../src/host/server';

const repoRoot = path.resolve(__dirname, '..');
const runtimeBundlePath = path.join(repoRoot, 'dist/iframe/runtime.js');
const localhostDevServerUrl = 'http://localhost:3000';

test('proxies a running localhost:3000 dev server without rendering a blank page', async ({
  page,
}) => {
  test.skip(
    !(await isReachable(localhostDevServerUrl)),
    'localhost:3000 dev server is not running',
  );

  const harness = await createDevServerHarness();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  try {
    await page.goto(harness.url('src/app/page.tsx'), { waitUntil: 'domcontentloaded' });

    await expect
      .poll(() => runtimeState(page), {
        message: 'Finesse runtime should load into the proxied localhost:3000 app',
      })
      .toMatchObject({ loaded: true, renderMode: 'react' });
    await expect
      .poll(() => visibleTextLength(page), {
        message: 'proxied localhost:3000 app should render visible text',
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => editableElementCount(page), {
        message: 'proxied localhost:3000 app should expose data-loc elements to Finesse',
      })
      .toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
    expect(
      consoleErrors.filter((message) => !message.includes('Download the React DevTools')),
    ).toEqual([]);
  } finally {
    await harness.dispose();
  }
});

async function createDevServerHarness(): Promise<{
  url(sourcePath: string): string;
  dispose(): Promise<void>;
}> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finesse-localhost-dev-'));
  const server = createPreviewServer({
    workspaceRoot,
    port: 'auto',
    runtimeBundlePath,
    getDocumentText: () => null,
    getInjectedPreviewHtml: () => null,
    getOffsetMap: () => null,
    isTemplated: () => false,
    getReactDevServerUrl: () => localhostDevServerUrl,
  });
  const port = await server.start();
  return {
    url(sourcePath: string): string {
      return `http://127.0.0.1:${port}/__react?source=${encodeURIComponent(sourcePath)}`;
    },
    async dispose(): Promise<void> {
      await dispose(server, workspaceRoot);
    },
  };
}

async function dispose(server: PreviewServer, workspaceRoot: string): Promise<void> {
  await server.stop();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

async function runtimeState(page: Page): Promise<{ loaded: boolean; renderMode?: string }> {
  return page.evaluate(() => {
    const init = window.__FINESSE__;
    return {
      loaded: Boolean(init),
      renderMode: init?.fileMeta.renderMode,
    };
  });
}

async function visibleTextLength(page: Page): Promise<number> {
  return page.evaluate(() => (document.body.innerText ?? '').trim().length);
}

async function editableElementCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-finesse-id]').length);
}
