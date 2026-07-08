/**
 * Finesse design tokens for the injected preview chrome.
 *
 * All Finesse UI drawn over the user's page (selection ring, pins, composers,
 * help panel, toolbar accents) reads `--finesse-*` custom properties instead
 * of hard-coded colors. The defaults below give a self-contained dark palette
 * so the chrome renders sensibly before the webview connects; once the
 * webview forwards the live VS Code theme (a {@link FinesseTheme} message),
 * the overrides land here and every surface follows the editor's look.
 *
 * The variables are set on `document.documentElement` (not a <style> block)
 * so they win against page-level `:root` rules without specificity games.
 */

import type { FinesseTheme } from '../shared/protocol';

export const FINESSE_TOKEN_DEFAULTS: Record<string, string> = {
  // Typography
  'finesse-font': 'system-ui, -apple-system, "Segoe UI", sans-serif',
  'finesse-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // Accent (primary buttons, selection, active pin)
  'finesse-accent': '#2f6fe0',
  'finesse-accent-hover': '#3a7cf0',
  'finesse-accent-fg': '#ffffff',
  // Focus outline / selection ring
  'finesse-focus': '#4c8dff',
  // Floating surfaces (composer, help panel, hint chips)
  'finesse-surface': '#1b1f27',
  'finesse-surface-fg': '#e8ecf3',
  'finesse-surface-border': 'rgba(255, 255, 255, 0.10)',
  // Inputs on floating surfaces
  'finesse-input-bg': 'rgba(255, 255, 255, 0.05)',
  'finesse-input-fg': '#e8ecf3',
  'finesse-input-border': 'rgba(255, 255, 255, 0.12)',
  'finesse-placeholder': '#8a96a8',
  // Text roles
  'finesse-muted': '#8fa0b8',
  // Status roles
  'finesse-danger': '#ff9a9a',
  'finesse-danger-bg': 'rgba(209, 69, 69, 0.12)',
  'finesse-danger-border': 'rgba(209, 69, 69, 0.35)',
  'finesse-success': '#2f9e57',
  'finesse-warn': '#d9a83a',
  // Depth
  'finesse-shadow': '0 10px 30px rgba(0, 0, 0, 0.45)',
  'finesse-shadow-small': '0 2px 8px rgba(0, 0, 0, 0.25)',
};

/** Token keys the webview is allowed to override. */
const KNOWN_TOKENS = new Set(Object.keys(FINESSE_TOKEN_DEFAULTS));

/** Install the default palette; call once at iframe boot. */
export function installThemeDefaults(): void {
  applyTokens(FINESSE_TOKEN_DEFAULTS);
}

/** Apply a theme message from the webview. Unknown/empty tokens are ignored. */
export function applyFinesseTheme(msg: FinesseTheme): void {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(msg.tokens ?? {})) {
    if (!KNOWN_TOKENS.has(key)) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    safe[key] = value.trim();
  }
  applyTokens(safe);
}

function applyTokens(tokens: Record<string, string>): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${key}`, value);
  }
}

/** Convenience for TS call-sites that want a token reference. */
export function token(name: string): string {
  return `var(--${name})`;
}
