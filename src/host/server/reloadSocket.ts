import type * as http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

interface SubInfo {
  socket: WebSocket;
  path: string | null;
}

export class ReloadSocket {
  private wss: WebSocketServer | null = null;
  private readonly subs = new Set<SubInfo>();

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/__edit/socket' });
    this.wss.on('connection', (socket) => {
      const info: SubInfo = { socket, path: null };
      this.subs.add(info);
      socket.on('message', (data) => {
        try {
          const text = typeof data === 'string' ? data : data.toString('utf-8');
          const msg = JSON.parse(text) as { type?: string; path?: string };
          if (msg && msg.type === 'subscribe' && typeof msg.path === 'string') {
            info.path = msg.path;
          }
        } catch {
          // ignore malformed
        }
      });
      const cleanup = (): void => {
        this.subs.delete(info);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });
  }

  broadcast(path: string): void {
    const msg = JSON.stringify({ type: 'reload', path });
    for (const info of this.subs) {
      if (info.path === path && info.socket.readyState === WebSocket.OPEN) {
        info.socket.send(msg);
      }
    }
  }

  close(): void {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    for (const info of this.subs) {
      try {
        info.socket.close();
      } catch {
        // ignore
      }
    }
    this.subs.clear();
    wss.close();
  }
}
