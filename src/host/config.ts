import * as vscode from 'vscode';
import type { AgentProviderId } from '../shared/protocol';

export interface ResolvedConfig {
  port: number | 'auto';
  editableElements: string[];
  templatePatterns: RegExp[];
  serverIdleTimeoutMs: number;
  reloadDebounceMs: number;
  openOnHtmlOpen: boolean;
  reactDevServerUrl: string;
  aiCommand: string;
  agentCursorModel: string;
  agentClaudeModel: string;
  agentDefaultProvider: AgentProviderId;
}

const DEFAULT_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]*\}\}/,
  /\{%[^%]*%\}/,
  /<%[^%]*%>/,
  /<\?[^?]*\?>/,
];

export function readConfig(): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration('finesse');
  const portRaw = cfg.get<number | string>('port', 'auto');
  const port: number | 'auto' = typeof portRaw === 'number' ? portRaw : 'auto';
  const tokenSources = cfg.get<string[]>('templateTokens', []);
  const compiled = tokenSources
    .map((src) => safeRegex(src))
    .filter((r): r is RegExp => r !== null);
  const templatePatterns =
    compiled.length > 0 ? compiled : Array.from(DEFAULT_TEMPLATE_PATTERNS);
  const rawProvider = cfg.get<string>('agent.provider', 'cursor');
  const agentDefaultProvider: AgentProviderId =
    rawProvider === 'claude-code' ? 'claude-code' : 'cursor';
  return {
    port,
    editableElements: cfg.get<string[]>('editableElements', []),
    templatePatterns,
    serverIdleTimeoutMs: cfg.get<number>('serverIdleTimeout', 60000),
    reloadDebounceMs: cfg.get<number>('reloadDebounceMs', 150),
    openOnHtmlOpen: cfg.get<boolean>('openOnHtmlOpen', false),
    reactDevServerUrl: cfg.get<string>('reactDevServerUrl', ''),
    aiCommand: cfg.get<string>('aiCommand', ''),
    agentCursorModel: cfg.get<string>('agent.cursorModel', 'composer-2'),
    agentClaudeModel: cfg.get<string>('agent.claudeModel', 'claude-opus-4-7'),
    agentDefaultProvider,
  };
}

export function onConfigChange(
  handler: (cfg: ResolvedConfig, event: vscode.ConfigurationChangeEvent) => void,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('finesse')) {
      handler(readConfig(), event);
    }
  });
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}
