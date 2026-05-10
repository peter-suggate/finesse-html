import * as vscode from 'vscode';
import type { AgentProviderId } from './types';

const CURSOR_API_KEY_SECRET = 'finesse.cursor.apiKey';
const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard';
const SETUP_TEXT = [
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

export type CredentialSource = 'secret' | 'environment' | 'prompt';

export interface AgentApiKey {
  value: string;
  source: CredentialSource;
}

export class AgentCredentialStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(providerId: AgentProviderId): Promise<AgentApiKey | undefined> {
    if (providerId !== 'cursor') return undefined;
    const stored = await this.context.secrets.get(CURSOR_API_KEY_SECRET);
    if (stored) return { value: stored, source: 'secret' };
    if (process.env.CURSOR_API_KEY) {
      return { value: process.env.CURSOR_API_KEY, source: 'environment' };
    }
    return undefined;
  }

  async ensureApiKey(providerId: AgentProviderId): Promise<AgentApiKey | undefined> {
    const existing = await this.getApiKey(providerId);
    if (existing) return existing;
    if (providerId !== 'cursor') return undefined;
    return this.promptForCursorApiKey();
  }

  async clearApiKey(providerId: AgentProviderId): Promise<void> {
    if (providerId !== 'cursor') return;
    await this.context.secrets.delete(CURSOR_API_KEY_SECRET);
  }

  async showStatus(providerId: AgentProviderId): Promise<void> {
    if (providerId !== 'cursor') return;
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
    if (choice === 'Connect Now') await this.ensureApiKey(providerId);
  }

  private async promptForCursorApiKey(): Promise<AgentApiKey | undefined> {
    while (true) {
      const choice = await vscode.window.showInformationMessage(
        SETUP_TEXT,
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
}
