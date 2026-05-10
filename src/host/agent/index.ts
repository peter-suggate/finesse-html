import * as vscode from 'vscode';
import type { ElementSelectionSnapshot, OffsetMap } from '../../shared/protocol';
import { buildElementSourceReference } from './selection';
import { CursorAgentProvider } from './providers/cursor';
import { AgentCredentialStore } from './credentials';
import type { AgentElementRequest, AgentProvider, AgentProviderId } from './types';

export interface RunSelectedElementAgentOpts {
  providerId: AgentProviderId;
  context: vscode.ExtensionContext;
  workspaceRoot: string;
  model: string;
  document: vscode.TextDocument;
  relativePath: string;
  offsetMap: OffsetMap;
  selection: ElementSelectionSnapshot;
  userPrompt: string;
}

const output = vscode.window.createOutputChannel('Finesse Agent');

const providers: Record<AgentProviderId, AgentProvider> = {
  cursor: new CursorAgentProvider(),
};

export async function runSelectedElementAgent(
  opts: RunSelectedElementAgentOpts,
): Promise<void> {
  const provider = providers[opts.providerId];
  if (!provider) throw new Error(`Unknown agent provider: ${opts.providerId}`);

  const element = buildElementSourceReference({
    document: opts.document,
    relativePath: opts.relativePath,
    offsetMap: opts.offsetMap,
    selection: opts.selection,
  });

  output.show(true);
  output.appendLine(`Finesse agent request via ${provider.label}`);
  output.appendLine(`Target: ${element.workspaceRelativePath}:${element.start.line}`);
  output.appendLine('');
  output.appendLine('[status] Checking Cursor Agent credentials...');

  const credentials = new AgentCredentialStore(opts.context);
  const apiKey = await credentials.ensureApiKey(opts.providerId);
  if (!apiKey) {
    output.appendLine('[status] No Cursor Agent API key is configured. Agent run cancelled before any SDK call.');
    output.appendLine(
      '[status] Use "Finesse: Connect Cursor Agent" or set CURSOR_API_KEY and reload Cursor.',
    );
    void vscode.window.showInformationMessage(
      'Finesse did not run Cursor Agent because no API key is configured.',
    );
    return;
  }
  output.appendLine(`[status] Using Cursor Agent API key from ${apiKey.source}.`);

  const request: AgentElementRequest = {
    providerId: opts.providerId,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    apiKey: apiKey.value,
    userPrompt: opts.userPrompt,
    element,
  };

  await provider.runElementRequest(request, {
    status(message) {
      output.appendLine(`\n[status] ${message}`);
    },
    output(message) {
      output.append(message);
    },
  });
}
