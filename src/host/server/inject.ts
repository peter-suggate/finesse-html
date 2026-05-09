import type { FileMeta, OffsetMap } from '../../shared/protocol';

export interface InjectionPayload {
  offsetMap: OffsetMap | null;
  fileMeta: FileMeta;
}

const RUNTIME_SCRIPT_TAG = '<script src="/__edit/runtime.js"></script>';

function jsonForScript(value: unknown): string {
  // Escape "</" sequences inside JSON strings so a payload can't break out of <script>.
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

export function injectInstrumentation(html: string, payload: InjectionPayload): string {
  const initScript = `<script>window.__HTML_WYSIWYG__ = ${jsonForScript(payload)};</script>`;
  const injected = `\n${initScript}\n${RUNTIME_SCRIPT_TAG}\n`;
  const bodyClose = lastMatchIndex(html, /<\/body\s*>/i);
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + injected + html.slice(bodyClose);
  }
  const htmlClose = lastMatchIndex(html, /<\/html\s*>/i);
  if (htmlClose >= 0) {
    return html.slice(0, htmlClose) + injected + html.slice(htmlClose);
  }
  return html + injected;
}

function lastMatchIndex(haystack: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    last = match.index;
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return last;
}
