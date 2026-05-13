import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentCredentialStore } from './agent/credentials';
import { ALL_AGENT_PROVIDER_IDS, isAgentProviderId } from './agent/types';
import type { ResolvedConfig } from './config';
import { createPreviewPanel, type PreviewPanel } from './panel';
import type { PreviewServer } from './server';

export interface CommandsContext {
  getPanel(key: string): PreviewPanel | undefined;
  setPanel(key: string, panel: PreviewPanel): void;
  deletePanel(key: string): void;
  listPanels(): PreviewPanel[];
  ensureServer(): Promise<PreviewServer>;
  getConfig(): ResolvedConfig;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  ctx: CommandsContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('finesse.openPreview', () =>
      openPreview(context, ctx),
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
      selectAgentProvider(),
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

export function isPreviewableLanguage(languageId: string): boolean {
  return PREVIEWABLE_LANGUAGES.has(languageId);
}

function isInsideWorkspace(workspaceRoot: string, fsPath: string): boolean {
  const rel = path.relative(workspaceRoot, fsPath);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function openPreview(
  extContext: vscode.ExtensionContext,
  ctx: CommandsContext,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !PREVIEWABLE_LANGUAGES.has(editor.document.languageId)) {
    void vscode.window.showInformationMessage(
      'Open an HTML, JS, or TS file to preview.',
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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    const parent = path.dirname(doc.uri.fsPath);
    const choice = await vscode.window.showErrorMessage(
      'Finesse needs an open workspace folder — the preview server only serves files under a workspace root.',
      'Open Containing Folder',
    );
    if (choice === 'Open Containing Folder') {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(parent),
        { forceNewWindow: false },
      );
    }
    return;
  }
  if (!isInsideWorkspace(workspaceRoot, doc.uri.fsPath)) {
    const fileName = path.basename(doc.uri.fsPath);
    const parent = path.dirname(doc.uri.fsPath);
    const rootName = path.basename(workspaceRoot);
    const choice = await vscode.window.showErrorMessage(
      `Finesse can't preview "${fileName}" — it sits outside the workspace folder "${rootName}". The preview server only serves files under the workspace root.`,
      'Open Containing Folder',
    );
    if (choice === 'Open Containing Folder') {
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(parent),
        { forceNewWindow: false },
      );
    }
    return;
  }
  const server = await ctx.ensureServer();
  const port = server.port;
  if (port === null) {
    void vscode.window.showErrorMessage('Preview server failed to start.');
    return;
  }
  const panel = createPreviewPanel(doc, {
    context: extContext,
    port,
    workspaceRoot,
    getConfig: ctx.getConfig,
    onDispose: () => ctx.deletePanel(key),
  });
  ctx.setPanel(key, panel);
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

async function selectAgentProvider(): Promise<void> {
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
  void vscode.window.showInformationMessage(`Finesse will now use ${pick.label}.`);
}
