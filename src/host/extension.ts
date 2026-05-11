import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { onConfigChange, readConfig, type ResolvedConfig } from './config';
import { handleDocumentChange } from './documentWatcher';
import { decideExternalFileConflict } from './externalFileConflict';
import { FileWatcher } from './fileWatcher';
import type { PreviewPanel } from './panel';
import { createPreviewServer, type PreviewServer } from './server';

interface ExtState {
  context: vscode.ExtensionContext;
  panels: Map<string, PreviewPanel>;
  server: PreviewServer | null;
  watcher: FileWatcher | null;
  config: ResolvedConfig;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let state: ExtState | null = null;

export function activate(context: vscode.ExtensionContext): void {
  state = {
    context,
    panels: new Map(),
    server: null,
    watcher: null,
    config: readConfig(),
    idleTimer: null,
  };

  registerCommands(context, {
    getPanel: (key) => state?.panels.get(key),
    setPanel: (key, panel) => {
      if (!state) return;
      state.panels.set(key, panel);
      cancelIdleShutdown();
    },
    deletePanel: (key) => {
      if (!state) return;
      state.panels.delete(key);
      if (state.panels.size === 0) scheduleIdleShutdown();
    },
    listPanels: () => Array.from(state?.panels.values() ?? []),
    ensureServer,
    getConfig: () => state?.config ?? readConfig(),
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
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const panels = state?.panels;
      if (!panels) return;
      for (const panel of panels.values()) {
        if (panel.documentUri.toString() === doc.uri.toString()) {
          panel.onDocumentSaved(doc);
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!state?.config.openOnHtmlOpen) return;
      if (doc.languageId !== 'html') return;
      // Only auto-open if there isn't already a panel for it.
      if (state.panels.has(doc.uri.toString())) return;
      void vscode.commands.executeCommand('finesse.openPreview');
    }),
    onConfigChange((cfg) => {
      if (!state) return;
      state.config = cfg;
      state.watcher?.setDebounce(cfg.reloadDebounceMs);
      // Re-parse all open panels with new template patterns
      for (const panel of state.panels.values()) {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === panel.documentUri.toString(),
        );
        if (doc) panel.onDocumentChanged(doc, 'external');
      }
    }),
  );
}

export function deactivate(): void {
  if (!state) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  for (const panel of state.panels.values()) panel.dispose();
  state.panels.clear();
  state.watcher?.dispose();
  state.watcher = null;
  void state.server?.stop();
  state = null;
}

function scheduleIdleShutdown(): void {
  if (!state || state.idleTimer) return;
  const ms = state.config.serverIdleTimeoutMs;
  if (ms <= 0) return;
  state.idleTimer = setTimeout(() => {
    if (!state) return;
    state.idleTimer = null;
    if (state.panels.size > 0) return;
    void state.server?.stop();
    state.server = null;
    state.watcher?.dispose();
    state.watcher = null;
  }, ms);
}

function cancelIdleShutdown(): void {
  if (!state?.idleTimer) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
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
  const runtimeBundlePath = path.join(
    state.context.extensionPath,
    'dist',
    'iframe',
    'runtime.js',
  );
  const server = createPreviewServer({
    workspaceRoot,
    port: state.config.port,
    runtimeBundlePath,
    getDocumentText: (relPath) => readDocumentText(workspaceRoot, relPath),
    getInjectedPreviewHtml: (relPath) =>
      findPanelByRel(workspaceRoot, relPath)?.currentInjectedPreviewHtml ?? null,
    getOffsetMap: (relPath) => findPanelByRel(workspaceRoot, relPath)?.currentOffsetMap ?? null,
    isTemplated: (relPath) => findPanelByRel(workspaceRoot, relPath)?.isTemplated ?? false,
  });
  await server.start();
  state.server = server;

  if (!state.watcher) {
    state.watcher = new FileWatcher({
      debounceMs: state.config.reloadDebounceMs,
      onHtmlChange: (uri) => {
        if (!state) return;
        void handleExternalHtmlChange(uri);
      },
      onAssetChange: (_uri) => {
        // Any CSS/JS/asset change → reload all previews so they pull the new resource.
        state?.server?.notifyReloadAll();
      },
    });
  }

  return server;
}

async function handleExternalHtmlChange(uri: vscode.Uri): Promise<void> {
  if (!state) return;
  const fsPath = uri.fsPath;
  const panel = Array.from(state.panels.values()).find(
    (p) => p.documentUri.fsPath === fsPath,
  );
  if (!panel) return;

  let diskText: string;
  try {
    diskText = fs.readFileSync(fsPath, 'utf-8');
  } catch {
    // File deleted/unreadable between watcher fire and read — nothing to do.
    return;
  }

  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  if (!doc) {
    // Doc isn't open in any editor: open it (which reads from disk) and
    // dispatch through the regular change path.
    const freshDoc = await vscode.workspace.openTextDocument(uri);
    panel.onDocumentChanged(freshDoc, 'external');
    return;
  }

  const conflictDecision = decideExternalFileConflict({
    diskText,
    documentText: doc.getText(),
    isDirty: doc.isDirty,
  });
  if (conflictDecision.action === 'noop') {
    // Watcher fired but content matches in-memory.
    return;
  }

  const dirtyText = conflictDecision.documentState === 'dirty' ? ' with unsaved edits' : '';
  const choice = await vscode.window.showWarningMessage(
    `${path.basename(fsPath)} changed on disk${dirtyText}. What should Finesse do?`,
    { modal: false },
    'Reload from disk',
    'Keep editor contents',
  );
  if (choice !== 'Reload from disk') return;

  await replaceDocumentText(doc, diskText);
  await doc.save();
}

async function replaceDocumentText(
  doc: vscode.TextDocument,
  newText: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(doc.getText().length),
  );
  edit.replace(doc.uri, fullRange, newText);
  await vscode.workspace.applyEdit(edit);
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
