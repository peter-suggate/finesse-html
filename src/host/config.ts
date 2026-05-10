import * as vscode from 'vscode';

export interface ResolvedConfig {
  port: number | 'auto';
  editableElements: string[];
  templatePatterns: RegExp[];
  serverIdleTimeoutMs: number;
  reloadDebounceMs: number;
  openOnHtmlOpen: boolean;
  aiCommand: string;
}

const DEFAULT_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]*\}\}/,
  /\{%[^%]*%\}/,
  /<%[^%]*%>/,
  /<\?[^?]*\?>/,
];

export function readConfig(): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration('htmlWysiwyg');
  const portRaw = cfg.get<number | string>('port', 'auto');
  const port: number | 'auto' = typeof portRaw === 'number' ? portRaw : 'auto';
  const tokenSources = cfg.get<string[]>('templateTokens', []);
  const compiled = tokenSources
    .map((src) => safeRegex(src))
    .filter((r): r is RegExp => r !== null);
  const templatePatterns =
    compiled.length > 0 ? compiled : Array.from(DEFAULT_TEMPLATE_PATTERNS);
  return {
    port,
    editableElements: cfg.get<string[]>('editableElements', []),
    templatePatterns,
    serverIdleTimeoutMs: cfg.get<number>('serverIdleTimeout', 60000),
    reloadDebounceMs: cfg.get<number>('reloadDebounceMs', 150),
    openOnHtmlOpen: cfg.get<boolean>('openOnHtmlOpen', false),
    aiCommand: cfg.get<string>('aiCommand', ''),
  };
}

export function onConfigChange(handler: (cfg: ResolvedConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('htmlWysiwyg')) {
      handler(readConfig());
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
