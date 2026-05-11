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
  /** Receive status/output lines so callers can render them inline (e.g. webview popover). */
  onStatus?: (text: string) => void;
  onOutput?: (text: string) => void;
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
  // Use getApiKey, not ensureApiKey — the inline popover flow is in charge of
  // collecting a missing key. Surfacing the modal here would bring back the
  // exact UX we're removing.
  const apiKey = await credentials.getApiKey(opts.providerId);
  if (!apiKey) {
    const reason = 'Cursor Agent API key is not configured.';
    output.appendLine(`[status] ${reason}`);
    opts.onStatus?.(reason);
    throw new Error(reason);
  }
  const sourceNote = `Using Cursor Agent API key from ${apiKey.source}.`;
  output.appendLine(`[status] ${sourceNote}`);
  opts.onStatus?.(sourceNote);

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
      opts.onStatus?.(message);
    },
    output(message) {
      output.append(message);
      opts.onOutput?.(message);
    },
  });
}
