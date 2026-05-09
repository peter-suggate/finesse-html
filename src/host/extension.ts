import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { handleDocumentChange } from './documentWatcher';
import type { PreviewPanel } from './panel';
import { createPreviewServer, type PreviewServer } from './server';

interface ExtState {
  context: vscode.ExtensionContext;
  panels: Map<string, PreviewPanel>;
  server: PreviewServer | null;
}

let state: ExtState | null = null;

export function activate(context: vscode.ExtensionContext): void {
  state = {
    context,
    panels: new Map(),
    server: null,
  };

  registerCommands(context, {
    getPanel: (key) => state?.panels.get(key),
    setPanel: (key, panel) => {
      state?.panels.set(key, panel);
    },
    deletePanel: (key) => {
      state?.panels.delete(key);
    },
    listPanels: () => Array.from(state?.panels.values() ?? []),
    ensureServer,
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const panels = state?.panels;
      if (!panels) return;
      for (const panel of panels.values()) {
        if (panel.documentUri.toString() === event.document.uri.toString()) {
          handleDocumentChange(event, panel);
        }
      }
    }),
  );
}

export function deactivate(): void {
  if (!state) return;
  for (const panel of state.panels.values()) panel.dispose();
  state.panels.clear();
  void state.server?.stop();
  state = null;
}

async function ensureServer(): Promise<PreviewServer> {
  if (!state) throw new Error('extension not activated');
  if (state.server) {
    await state.server.start();
    return state.server;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error('No workspace folder open.');
  }
  const config = vscode.workspace.getConfiguration('htmlWysiwyg');
  const portSetting = config.get<number | string>('port', 'auto');
  const port: number | 'auto' = typeof portSetting === 'number' ? portSetting : 'auto';
  const runtimeBundlePath = path.join(
    state.context.extensionPath,
    'dist',
    'iframe',
    'runtime.js',
  );
  const server = createPreviewServer({
    workspaceRoot,
    port,
    runtimeBundlePath,
    getDocumentText: (relPath) => readDocumentText(workspaceRoot, relPath),
    getOffsetMap: (relPath) => findPanelByRel(workspaceRoot, relPath)?.currentOffsetMap ?? null,
    isTemplated: (relPath) => findPanelByRel(workspaceRoot, relPath)?.isTemplated ?? false,
  });
  await server.start();
  state.server = server;
  return server;
}

function readDocumentText(workspaceRoot: string, relPath: string): string | null {
  const fsPath = path.resolve(workspaceRoot, relPath);
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.fsPath === fsPath) return doc.getText();
  }
  return null;
}

function findPanelByRel(workspaceRoot: string, relPath: string): PreviewPanel | null {
  const panels = state?.panels;
  if (!panels) return null;
  for (const p of panels.values()) {
    const r = path.relative(workspaceRoot, p.documentUri.fsPath).split(path.sep).join('/');
    if (r === relPath) return p;
  }
  return null;
}
