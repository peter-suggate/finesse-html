/**
 * Standalone harness for Playwright tests against the right-hand style
 * panel. Mounts {@link setupSidePanel} into a blank page and exposes:
 *
 *   - `__testSetSelection(snapshot | null)` — drive selection changes
 *   - `__testSetLocked(locked)` — toggle templated-file lock
 *   - `__testMessages` — array of PanelStyleEdit / PanelCssEdit messages the
 *     panel emitted (most recent last)
 *   - `__testClearMessages()` — reset the message log between assertions
 *
 * This bypasses the full webview bootstrap (which needs `acquireVsCodeApi`,
 * the iframe, server URL, etc.) so tests can focus purely on the side panel.
 */

import type {
  ElementSelectionSnapshot,
  PanelCssEdit,
  PanelStyleEdit,
} from '../../src/shared/protocol';
import { setupSidePanel } from '../../src/webview/stylePanel';

type Recorded = PanelStyleEdit | PanelCssEdit;

interface TestWindow extends Window {
  __testSetSelection: (snapshot: ElementSelectionSnapshot | null) => void;
  __testSetLocked: (locked: boolean) => void;
  __testMessages: Recorded[];
  __testClearMessages: () => void;
}

const w = window as unknown as TestWindow;
const host = document.getElementById('host');
if (!host) throw new Error('harness: missing #host');

const messages: Recorded[] = [];
w.__testMessages = messages;
w.__testClearMessages = () => {
  messages.length = 0;
};

const panel = setupSidePanel({
  host,
  sender: {
    toIframe(msg) {
      messages.push(msg);
    },
  },
});

w.__testSetSelection = (snapshot) => panel.setSelection(snapshot);
w.__testSetLocked = (locked) => panel.setLocked(locked);
