/**
 * Webview side of the Finesse theme bridge.
 *
 * VS Code exposes the active editor theme to webviews as `--vscode-*` CSS
 * variables. The preview iframe can't see those (it's a cross-origin page),
 * so we resolve the handful of tokens the injected Finesse chrome needs and
 * post them into the iframe as a {@link FinesseTheme} message — once when the
 * iframe reports ready, and again whenever the user switches themes.
 */

import type { FinesseTheme } from '../shared/protocol';

/** finesse token → vscode variable(s), first non-empty wins. */
const TOKEN_SOURCES: Record<string, string[]> = {
  'finesse-font': ['--vscode-font-family'],
  'finesse-mono': ['--vscode-editor-font-family'],
  'finesse-accent': ['--vscode-button-background'],
  'finesse-accent-hover': ['--vscode-button-hoverBackground', '--vscode-button-background'],
  'finesse-accent-fg': ['--vscode-button-foreground'],
  'finesse-focus': ['--vscode-focusBorder'],
  'finesse-surface': ['--vscode-editorWidget-background', '--vscode-menu-background'],
  'finesse-surface-fg': ['--vscode-editorWidget-foreground', '--vscode-foreground'],
  'finesse-surface-border': ['--vscode-editorWidget-border', '--vscode-panel-border'],
  'finesse-input-bg': ['--vscode-input-background'],
  'finesse-input-fg': ['--vscode-input-foreground'],
  'finesse-input-border': ['--vscode-input-border', '--vscode-panel-border'],
  'finesse-placeholder': ['--vscode-input-placeholderForeground', '--vscode-descriptionForeground'],
  'finesse-muted': ['--vscode-descriptionForeground'],
  'finesse-danger': ['--vscode-errorForeground'],
  'finesse-danger-bg': ['--vscode-inputValidation-errorBackground'],
  'finesse-danger-border': ['--vscode-inputValidation-errorBorder'],
  'finesse-success': ['--vscode-charts-green', '--vscode-testing-iconPassed'],
  'finesse-warn': ['--vscode-charts-yellow'],
};

/** Resolve the current theme into a token payload. Empty values are omitted
 * so the iframe keeps its own defaults for anything the theme doesn't define. */
export function computeFinesseThemeTokens(): Record<string, string> {
  const styles = getComputedStyle(document.body);
  const tokens: Record<string, string> = {};
  for (const [token, sources] of Object.entries(TOKEN_SOURCES)) {
    for (const source of sources) {
      const value = styles.getPropertyValue(source).trim();
      if (value) {
        tokens[token] = value;
        break;
      }
    }
  }
  return tokens;
}

export function buildThemeMessage(): FinesseTheme {
  return { type: 'finesseTheme', tokens: computeFinesseThemeTokens() };
}

/**
 * Invoke `onChange` (debounced) whenever VS Code swaps the theme. VS Code
 * restyles webviews by mutating class/style attributes on <html>/<body>.
 */
export function watchThemeChanges(onChange: () => void): () => void {
  let timer: number | undefined;
  const fire = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(onChange, 100);
  };
  const observer = new MutationObserver(fire);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}
