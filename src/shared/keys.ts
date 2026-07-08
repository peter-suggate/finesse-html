/**
 * Platform-aware keyboard shortcut labels, shared by every Finesse surface
 * (webview chrome, side panels, and the injected preview UI) so shortcut hints
 * never show a ⌘ to a Windows/Linux user or spell out "Ctrl" on a Mac.
 */

// Shared code compiles under both DOM (webview/iframe) and Node (host)
// configs, so reach for navigator via globalThis rather than the DOM global.
const nav = (globalThis as { navigator?: { platform?: string } }).navigator;

export const isMac: boolean =
  typeof nav?.platform === 'string' && /Mac|iPhone|iPad/i.test(nav.platform);

/** Primary modifier: `⌘` on Mac, `Ctrl` elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Shift modifier label: `⇧` on Mac, `Shift` elsewhere. */
export const SHIFT = isMac ? '⇧' : 'Shift';

/**
 * Compact modifier+key label, e.g. `⌘S` on Mac, `Ctrl+S` elsewhere.
 * Pass display glyphs (e.g. `↩`) or plain letters.
 */
export function modKey(key: string): string {
  return isMac ? `${MOD}${key}` : `${MOD}+${key}`;
}

/** Compact shift+mod+key label, e.g. `⇧⌘Z` / `Ctrl+Shift+Z`. */
export function shiftModKey(key: string): string {
  return isMac ? `${SHIFT}${MOD}${key}` : `${MOD}+${SHIFT}+${key}`;
}

/** The "send" shortcut shown next to composers: `⌘↩` / `Ctrl+↩`. */
export const SEND_KEY_LABEL = modKey('↩');
