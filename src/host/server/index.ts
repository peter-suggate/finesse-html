// Public surface for Stream 1B (HTTP server). Stream 1A imports from here.
import type { OffsetMap } from '../../shared/protocol';

export interface PreviewServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  notifyReload(workspaceRelativePath: string): void;
  /** Broadcast a reload to every subscribed iframe (used when shared assets change). */
  notifyReloadAll(): void;
  readonly port: number | null;
}

export interface PreviewServerOptions {
  workspaceRoot: string;
  /** "auto" or a specific port number. Default: "auto". */
  port?: number | 'auto';
  /** Absolute path to the iframe runtime bundle (dist/iframe/runtime.js). */
  runtimeBundlePath: string;
  getDocumentText: (workspaceRelativePath: string) => string | null;
  getOffsetMap: (workspaceRelativePath: string) => OffsetMap | null;
  isTemplated: (workspaceRelativePath: string) => boolean;
}

export { createPreviewServer } from './server';
