import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { onConfigChange, readConfig, type ResolvedConfig } from './config';
import { decideExternalFileConflict } from './externalFileConflict';
import { FileWatcher } from './fileWatcher';
import type { PreviewPanel } from './panel';
import { createPreviewServer, type PreviewServer } from './server';

interface ExtState {
  context: vscode.ExtensionContext;
  panels: Map<string, PreviewPanel>;
  runtimes: Map<string, PreviewRuntime>;
  config: ResolvedConfig;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface PreviewRuntime {
  server: PreviewServer;
  watcher: FileWatcher;
}

let state: ExtState | null = null;

export function activate(context: vscode.ExtensionContext): void {
  state = {
    context,
    panels: new Map(),
    runtimes: new Map(),
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
    setReactDevServerUrl: (url) => {
      if (!state) return;
      state.config = { ...state.config, reactDevServerUrl: url };
    },
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const panels = state?.panels;
      if (!panels) return;
      for (const panel of panels.values()) {
        if (panel.handlesDocument(event.document.uri)) {
          panel.onTextDocumentChanged(event);
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const panels = state?.panels;
      if (!panels) return;
      for (const panel of panels.values()) {
        if (panel.handlesDocument(doc.uri)) {
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
    onConfigChange((cfg, event) => {
      if (!state) return;
      state.config = cfg;
      if (event.affectsConfiguration('finesse.reloadDebounceMs')) {
        for (const runtime of state.runtimes.values()) {
          runtime.watcher.setDebounce(cfg.reloadDebounceMs);
        }
      }

      if (event.affectsConfiguration('finesse.agent.provider')) {
        for (const panel of state.panels.values()) {
          panel.setAgentProvider(cfg.agentDefaultProvider);
        }
      }

      if (
        event.affectsConfiguration('finesse.agent.claudeModel') ||
        event.affectsConfiguration('finesse.agent.cursorModel')
      ) {
        for (const panel of state.panels.values()) {
          panel.refreshAgentModel();
        }
      }

      const needsReparse =
        event.affectsConfiguration('finesse.editableElements') ||
        event.affectsConfiguration('finesse.templateTokens') ||
        event.affectsConfiguration('finesse.reactDevServerUrl');
      if (!needsReparse) return;

      // Re-parse all open panels with source-affecting config changes.
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
  for (const runtime of state.runtimes.values()) {
    runtime.watcher.dispose();
    void runtime.server.stop();
  }
  state.runtimes.clear();
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
    for (const runtime of state.runtimes.values()) {
      runtime.watcher.dispose();
      void runtime.server.stop();
    }
    state.runtimes.clear();
  }, ms);
}

function cancelIdleShutdown(): void {
  if (!state?.idleTimer) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

async function ensureServer(previewRoot: string): Promise<PreviewServer> {
  if (!state) throw new Error('extension not activated');
  const root = path.resolve(previewRoot);
  const existing = state.runtimes.get(root);
  if (existing) {
    await existing.server.start();
    return existing.server;
  }
  const runtimeBundlePath = path.join(
    state.context.extensionPath,
    'dist',
    'iframe',
    'runtime.js',
  );
  const server = createPreviewServer({
    workspaceRoot: root,
    port: state.runtimes.size === 0 ? state.config.port : 'auto',
    runtimeBundlePath,
    getDocumentText: (relPath) => readDocumentText(root, relPath),
    getInjectedPreviewHtml: (relPath) =>
      findPanelForPath(root, relPath)?.getInjectedPreviewHtmlForPath(relPath) ?? null,
    getOffsetMap: (relPath) =>
      findPanelForPath(root, relPath)?.getOffsetMapForPath(relPath) ?? null,
    isTemplated: (relPath) =>
      findPanelForPath(root, relPath)?.isTemplatedPath(relPath) ?? false,
    getReactDevServerUrl: () => state?.config.reactDevServerUrl || null,
  });
  await server.start();
  const watcher = new FileWatcher({
    root: vscode.Uri.file(root),
    debounceMs: state.config.reloadDebounceMs,
    onHtmlChange: (uri) => {
      if (!state) return;
      void handleExternalHtmlChange(uri);
    },
    onAssetChange: (_uri) => {
      server.notifyReloadAll();
    },
  });
  state.runtimes.set(root, { server, watcher });

  return server;
}

async function handleExternalHtmlChange(uri: vscode.Uri): Promise<void> {
  if (!state) return;
  const fsPath = uri.fsPath;
  const panel = Array.from(state.panels.values()).find(
    (p) => p.handlesDocument(uri) || p.documentUri.fsPath === fsPath,
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

function findPanelForPath(workspaceRoot: string, relPath: string): PreviewPanel | null {
  const panels = state?.panels;
  if (!panels) return null;
  for (const p of panels.values()) {
    const r = path.relative(workspaceRoot, p.documentUri.fsPath).split(path.sep).join('/');
    if (r === relPath) return p;
  }
  return null;
}
