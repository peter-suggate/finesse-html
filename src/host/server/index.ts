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
  /**
   * Pre-built preview HTML for the given path with `data-html-wysiwyg-id`
   * attrs already spliced in. Used for JS/TS files whose preview is composed
   * from template-literal bodies — the in-memory offset map for those uses
   * JS-source coordinates, so the server can't inject IDs into the served
   * bytes itself. Returns `null` when no JS-mode panel is active for the
   * path; the server then either treats it as a disk-backed HTML file or
   * serves it as a static asset, depending on extension.
   */
  getInjectedPreviewHtml: (workspaceRelativePath: string) => string | null;
  getOffsetMap: (workspaceRelativePath: string) => OffsetMap | null;
  isTemplated: (workspaceRelativePath: string) => boolean;
}

export { createPreviewServer } from './server';
