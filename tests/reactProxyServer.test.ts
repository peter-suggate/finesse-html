import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createPreviewServer, type PreviewServer } from '../src/host/server';
import type { PreviewServerOptions } from '../src/host/server';

describe('React dev server proxy', () => {
  it('proxies the configured Next URL through /__react and injects the runtime', async () => {
    const next = await createFakeNextServer();
    const workspace = createWorkspace();
    const preview = await createTestPreviewServer(workspace.root, {
      getReactDevServerUrl: () => next.url('/landing?draft=1'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${preview.port}/__react?source=src/app/page.tsx`);
      const html = await res.text();

      expect(next.requests).toContain('/landing?draft=1');
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(html).toContain('/__edit/runtime.js');
      expect(html).toContain('__FINESSE_COOKIE_COMPAT_INSTALLED__');
      expect(html.indexOf('__FINESSE_COOKIE_COMPAT_INSTALLED__')).toBeLessThan(
        html.indexOf('<script src="/_next/static/chunks/app.js">'),
      );
      expect(html).toContain('"path":"src/app/page.tsx"');
      expect(html).toContain('"renderMode":"react"');
    } finally {
      await preview.stop();
      await next.stop();
      workspace.dispose();
    }
  });

  it('requests identity encoding before rewriting Next HTML', async () => {
    const next = await createFakeNextServer();
    const workspace = createWorkspace();
    const preview = await createTestPreviewServer(workspace.root, {
      getReactDevServerUrl: () => next.url('/landing'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${preview.port}/__react?source=src/app/page.tsx`, {
        headers: { 'accept-encoding': 'br, gzip, deflate' },
      });
      const html = await res.text();

      expect(next.requestHeaders.at(-1)?.['accept-encoding']).toBe('identity');
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(html).toContain('/__edit/runtime.js');
    } finally {
      await preview.stop();
      await next.stop();
      workspace.dispose();
    }
  });

  it('proxies Next assets and app routes while preserving real workspace files', async () => {
    const next = await createFakeNextServer();
    const workspace = createWorkspace({
      'local.html': '<!doctype html><html><body><p>Local file</p></body></html>',
    });
    const preview = await createTestPreviewServer(workspace.root, {
      getReactDevServerUrl: () => next.url('/landing'),
    });
    try {
      const asset = await fetch(`http://127.0.0.1:${preview.port}/_next/static/chunks/app.js`);
      expect(await asset.text()).toBe('console.log("next asset");');
      expect(asset.headers.get('content-encoding')).toBe('gzip');

      const route = await fetch(`http://127.0.0.1:${preview.port}/about`);
      const routeHtml = await route.text();
      expect(routeHtml).toContain('About from Next');
      expect(routeHtml).toContain('/__edit/runtime.js');

      const local = await fetch(`http://127.0.0.1:${preview.port}/local.html`);
      const localHtml = await local.text();
      expect(localHtml).toContain('Local file');
      expect(next.requests).not.toContain('/local.html');
    } finally {
      await preview.stop();
      await next.stop();
      workspace.dispose();
    }
  });

  it('forwards Next dev websocket upgrades', async () => {
    const next = await createFakeNextServer();
    const workspace = createWorkspace();
    const preview = await createTestPreviewServer(workspace.root, {
      getReactDevServerUrl: () => next.url('/landing'),
    });
    try {
      const response = await rawUpgrade(preview.port, '/_next/webpack-hmr');
      expect(response).toContain('101 Switching Protocols');
      expect(next.upgrades).toContain('/_next/webpack-hmr');
    } finally {
      await preview.stop();
      await next.stop();
      workspace.dispose();
    }
  });

  it('rewrites dev-server cookies so iframe login sessions survive in the preview', async () => {
    const next = await createFakeNextServer();
    const workspace = createWorkspace();
    const preview = await createTestPreviewServer(workspace.root, {
      getReactDevServerUrl: () => next.url('/landing'),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${preview.port}/api/login`, {
        method: 'POST',
      });

      expect(await res.text()).toBe('ok');
      expect(res.headers.getSetCookie()).toEqual([
        'sAccessToken=abc; Path=/; HttpOnly; SameSite=None; Secure',
        'sRefreshToken=def; Path=/api/auth; HttpOnly; Secure; SameSite=None',
      ]);
    } finally {
      await preview.stop();
      await next.stop();
      workspace.dispose();
    }
  });
});

async function createTestPreviewServer(
  workspaceRoot: string,
  overrides: Partial<PreviewServerOptions>,
): Promise<PreviewServer> {
  const runtimeBundlePath = path.join(workspaceRoot, 'runtime.js');
  fs.writeFileSync(runtimeBundlePath, 'window.__runtimeLoaded = true;');
  const server = createPreviewServer({
    workspaceRoot,
    port: 'auto',
    runtimeBundlePath,
    getDocumentText: () => null,
    getInjectedPreviewHtml: () => null,
    getOffsetMap: () => null,
    isTemplated: () => false,
    ...overrides,
  });
  await server.start();
  return server;
}

async function createFakeNextServer(): Promise<{
  requests: string[];
  requestHeaders: http.IncomingHttpHeaders[];
  upgrades: string[];
  url(pathname: string): string;
  stop(): Promise<void>;
}> {
  const requests: string[] = [];
  const requestHeaders: http.IncomingHttpHeaders[] = [];
  const upgrades: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    requestHeaders.push(req.headers);
    if (url.startsWith('/_next/static/chunks/app.js')) {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-encoding': 'gzip',
        'content-security-policy': "default-src 'none'",
      });
      res.end(gzipSync('console.log("next asset");'));
      return;
    }
    if (url.startsWith('/about')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1 data-loc="src/app/about/page.tsx:1:0">About from Next</h1></body></html>');
      return;
    }
    if (url.startsWith('/api/login')) {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'set-cookie': [
          'sAccessToken=abc; Path=/; HttpOnly; SameSite=Lax',
          'sRefreshToken=def; Path=/api/auth; HttpOnly; Secure',
        ],
      });
      res.end('ok');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY',
    });
    res.end(
      '<!doctype html><html><head><script src="/_next/static/chunks/app.js"></script></head><body><main data-loc="src/app/page.tsx:1:0">Landing</main></body></html>',
    );
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.url ?? '/');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        '\r\n',
    );
    socket.end();
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Next server did not bind');
  return {
    requests,
    requestHeaders,
    upgrades,
    url(pathname: string): string {
      return `http://127.0.0.1:${address.port}${pathname}`;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function createWorkspace(files: Record<string, string> = {}): {
  root: string;
  dispose(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finesse-react-proxy-'));
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

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function rawUpgrade(port: number | null, pathname: string): Promise<string> {
  if (port === null) throw new Error('preview server did not bind');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          '\r\n',
      );
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf-8');
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
