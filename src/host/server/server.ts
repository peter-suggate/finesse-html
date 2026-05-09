import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { URL } from 'node:url';
import type { FileMeta } from '../../shared/protocol';
import type { PreviewServer, PreviewServerOptions } from './index';
import { injectInstrumentation } from './inject';
import { ReloadSocket } from './reloadSocket';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  notifyReload(workspaceRelativePath: string): void {
    this.socket?.broadcast(workspaceRelativePath);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No index. Open a specific HTML file.');
      return;
    }

    if (pathname === '/__edit/runtime.js') {
      this.serveRuntime(req, res);
      return;
    }

    const relPath = pathname.replace(/^\/+/, '');
    const resolved = path.resolve(this.opts.workspaceRoot, relPath);
    const within = path.relative(this.opts.workspaceRoot, resolved);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      this.serveHtml(relPath, resolved, req, res);
    } else {
      this.serveStatic(resolved, ext, req, res);
    }
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
    const fileMeta: FileMeta = {
      type: 'fileMeta',
      path: relPath,
      isTemplated: this.opts.isTemplated(relPath),
    };
    const html = injectInstrumentation(source, { offsetMap, fileMeta });
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

export function createPreviewServer(opts: PreviewServerOptions): PreviewServer {
  return new PreviewServerImpl(opts);
}
