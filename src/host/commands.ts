import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentCredentialStore } from './agent/credentials';
import { ALL_AGENT_PROVIDER_IDS, isAgentProviderId } from './agent/types';
import type { ResolvedConfig } from './config';
import {
  createDevServerPreviewPanel,
  createPreviewPanel,
  type PreviewPanel,
} from './panel';
import type { PreviewServer } from './server';

export interface CommandsContext {
  getPanel(key: string): PreviewPanel | undefined;
  setPanel(key: string, panel: PreviewPanel): void;
  deletePanel(key: string): void;
  listPanels(): PreviewPanel[];
  ensureServer(previewRoot: string): Promise<PreviewServer>;
  getConfig(): ResolvedConfig;
  setReactDevServerUrl(url: string): void;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  ctx: CommandsContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('finesse.openPreview', () =>
      openPreview(context, ctx),
    ),
    vscode.commands.registerCommand('finesse.openDevServerPreview', () =>
      openDevServerPreview(context, ctx),
    ),
    vscode.commands.registerCommand('finesse.closePreview', () => closePreview(ctx)),
    vscode.commands.registerCommand('finesse.editAnyway', () => editAnyway()),
    vscode.commands.registerCommand('finesse.connectCursorAgent', () =>
      connectCursorAgent(context),
    ),
    vscode.commands.registerCommand('finesse.disconnectCursorAgent', () =>
      disconnectCursorAgent(context),
    ),
    vscode.commands.registerCommand('finesse.cursorAgentStatus', () =>
      cursorAgentStatus(context),
    ),
    vscode.commands.registerCommand('finesse.connectClaudeAgent', () =>
      connectClaudeAgent(context),
    ),
    vscode.commands.registerCommand('finesse.disconnectClaudeAgent', () =>
      disconnectClaudeAgent(context),
    ),
    vscode.commands.registerCommand('finesse.claudeAgentStatus', () =>
      claudeAgentStatus(context),
    ),
    vscode.commands.registerCommand('finesse.selectAgentProvider', () =>
      selectAgentProvider(ctx),
    ),
  );
}

const PREVIEWABLE_LANGUAGES: ReadonlySet<string> = new Set([
  'html',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
]);

const DEFAULT_DEV_SERVER_URL = 'http://localhost:3000';

export function isPreviewableLanguage(languageId: string): boolean {
  return PREVIEWABLE_LANGUAGES.has(languageId);
}

async function openPreview(
  extContext: vscode.ExtensionContext,
  ctx: CommandsContext,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !PREVIEWABLE_LANGUAGES.has(editor.document.languageId)) {
    void vscode.window.showInformationMessage(
      'Open an HTML, JS, TS, JSX, or TSX file to preview.',
    );
    return;
  }
  const doc = editor.document;
  const key = doc.uri.toString();
  const existing = ctx.getPanel(key);
  if (existing) {
    existing.reveal();
    return;
  }
  if (doc.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('Finesse can preview local files only.');
    return;
  }
  const previewRoot = resolvePreviewRoot(doc.uri);
  const server = await ctx.ensureServer(previewRoot);
  const port = server.port;
  if (port === null) {
    void vscode.window.showErrorMessage('Preview server failed to start.');
    return;
  }
  const panel = createPreviewPanel(doc, {
    context: extContext,
    port,
    workspaceRoot: previewRoot,
    getConfig: ctx.getConfig,
    onDispose: () => ctx.deletePanel(key),
  });
  ctx.setPanel(key, panel);
}

function resolvePreviewRoot(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) return workspaceFolder.uri.fsPath;
  return findNearestGitRoot(uri.fsPath) ?? path.dirname(uri.fsPath);
}

function findNearestGitRoot(fsPath: string): string | null {
  let dir = path.dirname(fsPath);
  while (true) {
    if (hasGitMarker(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    const stat = fs.statSync(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function openDevServerPreview(
  extContext: vscode.ExtensionContext,
  ctx: CommandsContext,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      'Finesse needs an open workspace folder to map dev-server DOM nodes back to source files.',
    );
    return;
  }

  const configured = ctx.getConfig().reactDevServerUrl.trim();
  const raw = await vscode.window.showInputBox({
    title: 'Finesse: Open Dev Server Preview',
    prompt: 'Enter the running React/Next dev server page URL.',
    value: configured || DEFAULT_DEV_SERVER_URL,
    placeHolder: DEFAULT_DEV_SERVER_URL,
    validateInput: (value) =>
      normalizeDevServerUrl(value) ? null : 'Enter a valid http:// or https:// URL.',
  });
  if (raw === undefined) return;
  const url = normalizeDevServerUrl(raw);
  if (!url) {
    void vscode.window.showErrorMessage('Enter a valid http:// or https:// dev server URL.');
    return;
  }

  await vscode.workspace
    .getConfiguration('finesse')
    .update('reactDevServerUrl', url, vscode.ConfigurationTarget.Workspace);
  ctx.setReactDevServerUrl(url);

  const server = await ctx.ensureServer(workspaceRoot);
  const port = server.port;
  if (port === null) {
    void vscode.window.showErrorMessage('Preview server failed to start.');
    return;
  }

  const key = `finesse-dev-server:${url}`;
  const existing = ctx.getPanel(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const panel = createDevServerPreviewPanel({
    context: extContext,
    port,
    workspaceRoot,
    getConfig: ctx.getConfig,
    onDispose: () => ctx.deletePanel(key),
  });
  ctx.setPanel(key, panel);
}

function normalizeDevServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function closePreview(ctx: CommandsContext): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const key = editor.document.uri.toString();
    const panel = ctx.getPanel(key);
    if (panel) {
      panel.dispose();
      return;
    }
  }
  for (const panel of ctx.listPanels()) panel.dispose();
}

async function editAnyway(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'html') {
    void vscode.window.showInformationMessage('Open an HTML file first.');
    return;
  }
  const doc = editor.document;
  const text = doc.getText();
  if (/\bdata-finesse-allow\s*=\s*["']?true["']?/i.test(text)) {
    void vscode.window.showInformationMessage('Override already applied.');
    return;
  }
  const match = /<html(\s[^>]*)?>/i.exec(text);
  if (!match) {
    void vscode.window.showErrorMessage('No <html> tag found.');
    return;
  }
  const insertPos = match.index + '<html'.length;
  const insertion = ' data-finesse-allow="true"';
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, doc.positionAt(insertPos), insertion);
  await vscode.workspace.applyEdit(edit);
}

async function connectCursorAgent(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.ensureApiKey('cursor');
}

async function disconnectCursorAgent(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.clearApiKey('cursor');
  void vscode.window.showInformationMessage('Cursor Agent disconnected from Finesse.');
}

async function cursorAgentStatus(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.showStatus('cursor');
}

async function connectClaudeAgent(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.ensureApiKey('claude-code');
}

async function disconnectClaudeAgent(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.clearApiKey('claude-code');
  void vscode.window.showInformationMessage(
    'Cleared stored Claude API key. Subscription login via the Claude CLI (if any) is still active.',
  );
}

async function claudeAgentStatus(context: vscode.ExtensionContext): Promise<void> {
  const credentials = new AgentCredentialStore(context);
  await credentials.showStatus('claude-code');
}

async function selectAgentProvider(ctx: CommandsContext): Promise<void> {
  const items = ALL_AGENT_PROVIDER_IDS.map((id) => ({
    label: id === 'cursor' ? 'Cursor Agent' : 'Claude Code',
    description: id,
    id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Finesse: Select Agent Provider',
    placeHolder: 'Which agent should run when you press Send in the Ask Agent panel?',
  });
  if (!pick) return;
  if (!isAgentProviderId(pick.id)) return;
  await vscode.workspace
    .getConfiguration('finesse')
    .update('agent.provider', pick.id, vscode.ConfigurationTarget.Global);
  for (const panel of ctx.listPanels()) {
    panel.setAgentProvider(pick.id);
  }
  void vscode.window.showInformationMessage(`Finesse will now use ${pick.label}.`);
}
