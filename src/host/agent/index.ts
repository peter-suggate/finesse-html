import * as vscode from 'vscode';
import type { ElementSelectionSnapshot, OffsetMap } from '../../shared/protocol';
import { buildElementSourceReference } from './selection';
import { CursorAgentProvider } from './providers/cursor';
import { ClaudeCodeAgentProvider } from './providers/claude';
import { AgentCredentialStore } from './credentials';
import type { AgentProvider, AgentProviderId, AgentRunSink } from './types';

export interface RunSelectedElementAgentOpts {
  providerId: AgentProviderId;
  context: vscode.ExtensionContext;
  workspaceRoot: string;
  model: string;
  document: vscode.TextDocument;
  relativePath: string;
  offsetMap?: OffsetMap;
  selection?: ElementSelectionSnapshot;
  userPrompt: string;
  /** Receive status/output lines so callers can render them inline (e.g. webview popover). */
  onStatus?: (text: string) => void;
  onOutput?: (text: string) => void;
}

const output = vscode.window.createOutputChannel('Finesse Agent');

const providers: Record<AgentProviderId, AgentProvider> = {
  cursor: new CursorAgentProvider(),
  'claude-code': new ClaudeCodeAgentProvider(),
};

export async function runSelectedElementAgent(
  opts: RunSelectedElementAgentOpts,
): Promise<void> {
  const provider = providers[opts.providerId];
  if (!provider) throw new Error(`Unknown agent provider: ${opts.providerId}`);

  const element =
    opts.selection && opts.offsetMap
      ? buildElementSourceReference({
          document: opts.document,
          relativePath: opts.relativePath,
          offsetMap: opts.offsetMap,
          selection: opts.selection,
        })
      : undefined;
  const page = {
    workspaceRelativePath: opts.relativePath,
    documentVersion: opts.document.version,
    languageId: opts.document.languageId,
    source: opts.document.getText(),
  };

  output.show(true);
  output.appendLine(`Finesse agent request via ${provider.label}`);
  output.appendLine(
    element
      ? `Target: ${element.workspaceRelativePath}:${element.start.line}`
      : `Target: ${page.workspaceRelativePath}`,
  );
  output.appendLine('');

  const credentials = new AgentCredentialStore(opts.context);
  const apiKey = await credentials.getApiKey(opts.providerId);

  if (opts.providerId === 'cursor') {
    output.appendLine('[status] Checking Cursor Agent credentials...');
    if (!apiKey) {
      const reason = 'Cursor Agent API key is not configured.';
      output.appendLine(`[status] ${reason}`);
      opts.onStatus?.(reason);
      throw new Error(reason);
    }
    const sourceNote = `Using Cursor Agent API key from ${apiKey.source}.`;
    output.appendLine(`[status] ${sourceNote}`);
    opts.onStatus?.(sourceNote);
  } else {
    output.appendLine('[status] Preparing Claude Code run...');
    if (apiKey) {
      const sourceNote = `Using ANTHROPIC_API_KEY from ${apiKey.source}.`;
      output.appendLine(`[status] ${sourceNote}`);
      opts.onStatus?.(sourceNote);
    } else {
      output.appendLine('[status] No API key stored — relying on Claude Code CLI subscription login.');
    }
  }

  const request = {
    providerId: opts.providerId,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    apiKey: apiKey?.value,
    userPrompt: opts.userPrompt,
  };

  const sink: AgentRunSink = {
    status(message: string) {
      output.appendLine(`\n[status] ${message}`);
      opts.onStatus?.(message);
    },
    output(message: string) {
      output.append(message);
      opts.onOutput?.(message);
    },
  };

  if (element) {
    await provider.runElementRequest({ ...request, element }, sink);
  } else {
    await provider.runPageRequest({ ...request, page }, sink);
  }
}
