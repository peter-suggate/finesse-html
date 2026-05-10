/**
 * Default wiring from toolbar action names → format helpers + EditSession ops.
 *
 * Kept separate from the controller so a host can swap in custom behavior
 * (e.g. a test harness that captures actions instead of mutating the DOM).
 */

import type { EditSession } from '../editSession';
import {
  applyInlineFormat,
  applyLink,
  clearFormatting,
  queryFormatState,
  type FormatState,
  type InlineFormat,
} from './format';
import { promptLink } from './linkPopover';
import type {
  ToolbarActionContext,
  ToolbarActionHandler,
  ToolbarActionName,
  ToolbarRefreshHandler,
} from './index';

/** Tags the user can transform a block to via the block-style dropdown. */
const BLOCK_TAG_OPTIONS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'blockquote',
]);

const INLINE_FORMATS: readonly InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'code'];

export interface DefaultWiringOpts {
  session: EditSession;
}

export function makeDefaultActionHandler(opts: DefaultWiringOpts): ToolbarActionHandler {
  const { session } = opts;
  return (name: ToolbarActionName, value, ctx: ToolbarActionContext) => {
    switch (name) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
      case 'code':
        applyInlineFormat(name, ctx.block);
        return;
      case 'link': {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const existing = currentLinkUrl(sel.focusNode, ctx.block);
        const range = sel.getRangeAt(0).cloneRange();
        const anchorRect = range.getBoundingClientRect();
        // Async — await user input, then restore the selection (focus may have
        // wandered to the popover input) before applying.
        void promptLink({ initialUrl: existing, anchor: anchorRect }).then((url) => {
          if (url === null) {
            ctx.block.focus({ preventScroll: true });
            const s = window.getSelection();
            if (s) {
              s.removeAllRanges();
              s.addRange(range);
            }
            return;
          }
          ctx.block.focus({ preventScroll: true });
          const s = window.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(range);
          }
          applyLink(url);
        });
        return;
      }
      case 'clear':
        clearFormatting();
        return;
      case 'block': {
        if (!value) return;
        const tag = value.toLowerCase();
        if (!BLOCK_TAG_OPTIONS.has(tag)) return;
        const currentTag = ctx.block.tagName.toLowerCase();
        if (currentTag === tag) {
          session.setPendingTag(null);
          return;
        }
        // Stage the rename so it commits atomically with any pending text/
        // formatting edits (commitEdit runs on Enter / click-out).
        session.setPendingTag(tag);
        return;
      }
    }
  };
}

export function makeDefaultRefreshHandler(opts: { session: EditSession }): ToolbarRefreshHandler {
  return (ctx: ToolbarActionContext, sel: Selection | null) => {
    const state = queryFormatState(sel, ctx.block);
    setActiveStates(ctx, state);
    const pending = opts.session.pendingTag();
    ctx.toolbar.setSelectValue('block', pending ?? ctx.block.tagName.toLowerCase());
  };
}

function setActiveStates(ctx: ToolbarActionContext, state: FormatState): void {
  for (const fmt of INLINE_FORMATS) {
    ctx.toolbar.setActive(fmt, state[fmt]);
  }
}

function currentLinkUrl(node: Node | null, boundary: HTMLElement): string {
  let cur: Node | null = node;
  while (cur && cur !== boundary) {
    if (cur instanceof HTMLAnchorElement) return cur.getAttribute('href') ?? '';
    cur = cur.parentNode;
  }
  return '';
}
