import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import type { FileMeta, OffsetMap } from '../../shared/protocol';
import type { PreviewServer, PreviewServerOptions } from './index';
import { injectElementIds, injectInstrumentation } from './inject';
import { ReloadSocket } from './reloadSocket';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

class PreviewServerImpl implements PreviewServer {
  private server: http.Server | null = null;
  private socket: ReloadSocket | null = null;
  private readonly proxySockets = new Set<Duplex>();
  private boundPort: number | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly opts: PreviewServerOptions;

  constructor(opts: PreviewServerOptions) {
    this.opts = opts;
  }

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.boundPort !== null) return this.boundPort;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private doStart(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          const message = err instanceof Error ? err.message : String(err);
          res.end(`Internal error: ${message}`);
        });
      });
      const onError = (err: Error): void => {
        reject(err);
      };
      server.once('error', onError);
      const desired = this.opts.port === undefined || this.opts.port === 'auto' ? 0 : this.opts.port;
      server.listen(desired, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind preview server'));
          return;
        }
        this.boundPort = address.port;
        this.server = server;
        this.socket = new ReloadSocket();
        this.socket.attach(server);
        server.on('upgrade', (req, socket, head) => {
          if ((req.url ?? '').startsWith('/__edit/socket')) return;
          this.handleUpgrade(req, socket, head);
        });
        resolve(this.boundPort);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    for (const socket of this.proxySockets) {
      socket.destroy();
    }
    this.proxySockets.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  notifyReload(workspaceRelativePath: string): void {
    this.socket?.broadcast(workspaceRelativePath);
  }

  notifyReloadAll(): void {
    this.socket?.broadcastAll();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/__edit/runtime.js') {
      this.serveRuntime(req, res);
      return;
    }

    if (pathname === '/__react' || pathname.startsWith('/__react/')) {
      this.proxyReact(pathname, req, res);
      return;
    }

    const relPath = pathname.replace(/^\/+/, '');
    const resolved = path.resolve(this.opts.workspaceRoot, relPath);
    const within = path.relative(this.opts.workspaceRoot, resolved);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `Forbidden: requested path "${pathname}" resolves outside the workspace root. The preview server only serves files under ${this.opts.workspaceRoot}.`,
      );
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const hasWorkspaceFile = isRegularFile(resolved);
    if (this.shouldProxyReactRequest(pathname, { hasWorkspaceFile })) {
      this.proxyReact(pathname, req, res);
      return;
    }
    if (pathname === '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No index. Open a specific HTML file.');
      return;
    }
    if (ext === '.html' || ext === '.htm') {
      this.serveHtml(relPath, resolved, req, res);
      return;
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
      const preInjected = this.opts.getInjectedPreviewHtml(relPath);
      if (preInjected !== null) {
        this.serveInjectedPreview(relPath, preInjected, req, res);
        return;
      }
    }
    this.serveStatic(resolved, ext, req, res);
  }

  private proxyReact(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const target = this.reactTargetFor(pathname, req.url ?? pathname);
    if (!target) {
      res.writeHead(503, diagnosticResponseHeaders('text/html; charset=utf-8'));
      res.end(reactSetupHtml());
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const headers = proxyRequestHeaders(req.headers, target, {
      // HTML responses are rewritten below, so ask the dev server for bytes we
      // can safely treat as UTF-8 instead of compressed browser payloads.
      acceptEncoding: 'identity',
    });
    const proxyReq = client.request(
      target,
      { method: req.method, headers },
      (proxyRes) => {
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        if (!contentType.includes('text/html')) {
          res.writeHead(proxyRes.statusCode ?? 200, proxyPassThroughHeaders(proxyRes.headers));
          proxyRes.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const source = Buffer.concat(chunks).toString('utf-8');
          const sourcePath = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('source') ?? '';
          const html = injectInstrumentation(source, {
            offsetMap: null,
            fileMeta: {
              type: 'fileMeta',
              path: sourcePath,
              isTemplated: false,
              renderMode: 'react',
            },
          });
          res.writeHead(proxyRes.statusCode ?? 200, {
            ...proxyRewrittenHtmlHeaders(proxyRes.headers),
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(html),
          });
          res.end(html);
        });
      },
    );
    proxyReq.on('error', (err) => {
      res.writeHead(502, diagnosticResponseHeaders('text/html; charset=utf-8'));
      res.end(reactProxyErrorHtml(err instanceof Error ? err.message : String(err)));
    });
    req.pipe(proxyReq);
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!this.shouldProxyReactRequest(pathname, { hasWorkspaceFile: false })) {
      socket.destroy();
      return;
    }
    const target = this.reactTargetFor(pathname, req.url ?? pathname);
    if (!target) {
      socket.destroy();
      return;
    }
    this.proxySockets.add(socket);
    const cleanup = (): void => {
      this.proxySockets.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    const client = target.protocol === 'https:' ? https : http;
    const proxyReq = client.request(target, {
      method: req.method,
      headers: proxyRequestHeaders(req.headers, target),
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v ?? ''}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length > 0) proxySocket.write(head);
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  }

  private shouldProxyReactRequest(
    pathname: string,
    opts: { hasWorkspaceFile?: boolean } = {},
  ): boolean {
    if (!this.opts.getReactDevServerUrl?.()) return false;
    if (pathname === '/__edit/runtime.js' || pathname.startsWith('/__edit/')) return false;
    return (
      pathname === '/__react' ||
      pathname.startsWith('/__react/') ||
      pathname.startsWith('/@vite') ||
      pathname.startsWith('/@react-refresh') ||
      pathname.startsWith('/src/') ||
      pathname.startsWith('/node_modules/') ||
      pathname.startsWith('/_next/') ||
      pathname.startsWith('/__next/') ||
      (!opts.hasWorkspaceFile && pathname.startsWith('/'))
    );
  }

  private reactTargetFor(pathname: string, rawUrl: string): URL | null {
    const configured = this.opts.getReactDevServerUrl?.()?.trim();
    if (!configured) return null;
    let base: URL;
    try {
      base = new URL(configured);
    } catch {
      return null;
    }
    const incoming = new URL(rawUrl, 'http://127.0.0.1');
    if (pathname === '/__react' || pathname.startsWith('/__react/')) {
      return base;
    }
    const target = new URL(base.toString());
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    return target;
  }

  private serveRuntime(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const stat = fs.statSync(this.opts.runtimeBundlePath);
      const etag = `W/"runtime-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        ETag: etag,
      });
      fs.createReadStream(this.opts.runtimeBundlePath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('iframe runtime bundle not built');
    }
  }

  private serveHtml(
    relPath: string,
    resolved: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let source = this.opts.getDocumentText(relPath);
    if (source === null) {
      try {
        source = fs.readFileSync(resolved, 'utf-8');
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
    }
    const offsetMap = this.opts.getOffsetMap(relPath);
    const withIds = injectElementIds(source, offsetMap);
    this.respondWithHtml(relPath, withIds, offsetMap, req, res);
  }

  private serveInjectedPreview(
    relPath: string,
    preInjectedHtml: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const offsetMap = this.opts.getOffsetMap(relPath);
    this.respondWithHtml(relPath, preInjectedHtml, offsetMap, req, res);
  }

  private respondWithHtml(
    relPath: string,
    htmlWithIds: string,
    offsetMap: OffsetMap | null,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const fileMeta: FileMeta = {
      type: 'fileMeta',
      path: relPath,
      isTemplated: this.opts.isTemplated(relPath),
      renderMode: reactSourceExt(relPath) ? 'react' : undefined,
    };
    const html = injectInstrumentation(htmlWithIds, { offsetMap, fileMeta });
    const etag = `W/"html-${offsetMap?.documentVersion ?? 0}-${html.length}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ETag: etag,
    });
    res.end(html);
  }

  private serveStatic(
    resolved: string,
    ext: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    try {
      const stat = fs.statSync(resolved);
      const etag = `W/"static-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, ETag: etag });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }
}

function proxyPassThroughHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {
    ...headers,
    'access-control-allow-origin': '*',
  };
  delete out['content-security-policy'];
  delete out['x-frame-options'];
  return out;
}

function proxyRequestHeaders(
  headers: http.IncomingHttpHeaders,
  target: URL,
  opts: { acceptEncoding?: string } = {},
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {
    ...headers,
    host: target.host,
  };
  if (opts.acceptEncoding) out['accept-encoding'] = opts.acceptEncoding;
  if (typeof headers.origin === 'string') {
    out.origin = target.origin;
  }
  if (typeof headers.referer === 'string') {
    try {
      const referer = new URL(headers.referer);
      referer.protocol = target.protocol;
      referer.host = target.host;
      out.referer = referer.toString();
    } catch {
      out.referer = `${target.origin}/`;
    }
  }
  return out;
}

function proxyRewrittenHtmlHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out = proxyPassThroughHeaders(headers);
  delete out['content-length'];
  delete out['transfer-encoding'];
  delete out['content-encoding'];
  return out;
}

function reactSetupHtml(): string {
  return `<!doctype html>
<html>
  <body>
    <h1>Configure React preview</h1>
    <p>Set <code>finesse.reactDevServerUrl</code> to your running Vite or Next dev server URL.</p>
    <p>Install and enable <code>jsx-loc-plugin</code> in that app so Finesse can map DOM nodes to JSX source.</p>
  </body>
</html>`;
}

function diagnosticResponseHeaders(contentType: string): http.OutgoingHttpHeaders {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  };
}

function reactProxyErrorHtml(message: string): string {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
  <body>
    <h1>React preview unavailable</h1>
    <p>Finesse could not reach the configured React dev server.</p>
    <pre>${escaped}</pre>
  </body>
</html>`;
}

function reactSourceExt(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return ext === '.jsx' || ext === '.tsx';
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function createPreviewServer(opts: PreviewServerOptions): PreviewServer {
  return new PreviewServerImpl(opts);
}
