import * as vscode from 'vscode';
import type { AgentProviderId } from './types';

const CURSOR_API_KEY_SECRET = 'finesse.cursor.apiKey';
const CLAUDE_API_KEY_SECRET = 'finesse.claude.apiKey';
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard';
const CLAUDE_DOCS_URL = 'https://code.claude.com/docs/en/agent-sdk/overview';

const SECRET_BY_PROVIDER: Record<AgentProviderId, string> = {
  cursor: CURSOR_API_KEY_SECRET,
  'claude-code': CLAUDE_API_KEY_SECRET,
};

const ENV_BY_PROVIDER: Record<AgentProviderId, string> = {
  cursor: 'CURSOR_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
};

const CURSOR_SETUP_TEXT = [
  'Finesse needs a Cursor Agent API key before it can run an agent.',
  '',
  'Steps:',
  '1. Open the Cursor Dashboard.',
  '2. Go to Integrations > User API Keys.',
  '3. Create or copy a User API Key.',
  '4. Come back to Cursor and choose Paste API Key.',
  '',
  'Finesse stores the key in extension secrets, not in this workspace.',
].join('\n');

const CLAUDE_SETUP_TEXT = [
  "Finesse can use Claude Code via your Claude subscription — no API key needed.",
  '',
  'To authenticate the SDK with your subscription:',
  '1. Install Claude Code from https://claude.com/code (if not already).',
  '2. In a terminal, run `claude`.',
  '3. Run `/login` and complete the browser sign-in.',
  '',
  'Alternatively, paste an ANTHROPIC_API_KEY to use API-key auth instead.',
].join('\n');

export type CredentialSource = 'secret' | 'environment' | 'prompt';

export interface AgentApiKey {
  value: string;
  source: CredentialSource;
}

export class AgentCredentialStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(providerId: AgentProviderId): Promise<AgentApiKey | undefined> {
    const secretKey = SECRET_BY_PROVIDER[providerId];
    const envName = ENV_BY_PROVIDER[providerId];
    const stored = await this.context.secrets.get(secretKey);
    if (stored) return { value: stored, source: 'secret' };
    const envValue = envName ? process.env[envName] : undefined;
    if (envValue) return { value: envValue, source: 'environment' };
    return undefined;
  }

  async ensureApiKey(providerId: AgentProviderId): Promise<AgentApiKey | undefined> {
    const existing = await this.getApiKey(providerId);
    if (existing) return existing;
    if (providerId === 'cursor') return this.promptForCursorApiKey();
    return this.promptForClaudeAuth();
  }

  async clearApiKey(providerId: AgentProviderId): Promise<void> {
    const secretKey = SECRET_BY_PROVIDER[providerId];
    await this.context.secrets.delete(secretKey);
  }

  /**
   * Store an API key without any user-facing prompts. Used by the inline
   * connect panel in the webview — the user already saw the instructions
   * and pasted the key into the popover.
   */
  async setApiKey(providerId: AgentProviderId, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    const secretKey = SECRET_BY_PROVIDER[providerId];
    await this.context.secrets.store(secretKey, trimmed);
  }

  static get cursorDashboardUrl(): string {
    return CURSOR_DASHBOARD_URL;
  }

  static get claudeDocsUrl(): string {
    return CLAUDE_DOCS_URL;
  }

  async showStatus(providerId: AgentProviderId): Promise<void> {
    if (providerId === 'cursor') return this.showCursorStatus();
    return this.showClaudeStatus();
  }

  private async showCursorStatus(): Promise<void> {
    const stored = await this.context.secrets.get(CURSOR_API_KEY_SECRET);
    if (stored) {
      void vscode.window.showInformationMessage('Finesse has a stored Cursor Agent API key.');
      return;
    }
    if (process.env.CURSOR_API_KEY) {
      void vscode.window.showInformationMessage('Finesse is using CURSOR_API_KEY from the environment.');
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'Finesse is not connected to Cursor Agent yet.',
      'Connect Now',
    );
    if (choice === 'Connect Now') await this.ensureApiKey('cursor');
  }

  private async showClaudeStatus(): Promise<void> {
    const stored = await this.context.secrets.get(CLAUDE_API_KEY_SECRET);
    if (stored) {
      void vscode.window.showInformationMessage(
        'Finesse has a stored ANTHROPIC_API_KEY for Claude Code.',
      );
      return;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      void vscode.window.showInformationMessage(
        'Finesse is using ANTHROPIC_API_KEY from the environment for Claude Code.',
      );
      return;
    }
    void vscode.window.showInformationMessage(
      'No API key stored. Claude Code will use your existing CLI login (subscription) if available — run `claude` then `/login` to authenticate.',
    );
  }

  private async promptForCursorApiKey(): Promise<AgentApiKey | undefined> {
    while (true) {
      const choice = await vscode.window.showInformationMessage(
        CURSOR_SETUP_TEXT,
        { modal: true },
        'Open Dashboard',
        'Paste API Key',
        'Use CURSOR_API_KEY',
      );

      if (!choice) return undefined;
      if (choice === 'Open Dashboard') {
        await vscode.env.openExternal(vscode.Uri.parse(CURSOR_DASHBOARD_URL));
        continue;
      }
      if (choice === 'Use CURSOR_API_KEY') {
        void vscode.window.showInformationMessage(
          'Set CURSOR_API_KEY in the environment used to launch Cursor, then run Developer: Reload Window.',
        );
        return undefined;
      }

      const apiKey = await vscode.window.showInputBox({
        title: 'Cursor Agent API Key',
        prompt: 'Paste the User API Key from Cursor Dashboard > Integrations > User API Keys.',
        placeHolder: 'crsr_...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length > 0 ? null : 'Paste a Cursor Agent API key.',
      });
      if (!apiKey) return undefined;
      await this.context.secrets.store(CURSOR_API_KEY_SECRET, apiKey.trim());
      void vscode.window.showInformationMessage('Cursor Agent is connected for Finesse.');
      return { value: apiKey.trim(), source: 'prompt' };
    }
  }

  private async promptForClaudeAuth(): Promise<AgentApiKey | undefined> {
    while (true) {
      const choice = await vscode.window.showInformationMessage(
        CLAUDE_SETUP_TEXT,
        { modal: true },
        'Use Subscription',
        'Paste API Key',
        'Open Claude Docs',
      );
      if (!choice) return undefined;
      if (choice === 'Open Claude Docs') {
        await vscode.env.openExternal(vscode.Uri.parse(CLAUDE_DOCS_URL));
        continue;
      }
      if (choice === 'Use Subscription') {
        void vscode.window.showInformationMessage(
          'In a terminal, run `claude` then `/login`. Finesse will pick up that login automatically.',
        );
        return undefined;
      }
      const apiKey = await vscode.window.showInputBox({
        title: 'Anthropic API Key',
        prompt: 'Paste an ANTHROPIC_API_KEY to use API-key auth instead of subscription.',
        placeHolder: 'sk-ant-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length > 0 ? null : 'Paste an ANTHROPIC_API_KEY.',
      });
      if (!apiKey) return undefined;
      await this.context.secrets.store(CLAUDE_API_KEY_SECRET, apiKey.trim());
      void vscode.window.showInformationMessage('Claude Code is connected for Finesse.');
      return { value: apiKey.trim(), source: 'prompt' };
    }
  }
}
