import type { FileMeta, OffsetMap } from '../../shared/protocol';

export interface InjectionPayload {
  offsetMap: OffsetMap | null;
  fileMeta: FileMeta;
}

/**
 * Splice `data-finesse-id="N"` into each selectable element's opening tag.
 * The iframe uses these as stable handles that survive implicit DOM insertions
 * (e.g. browser-inserted `<tbody>`) and script mutations.
 *
 * Right-to-left? No — we precompute insertion points then build the output in
 * one ascending pass, so the original offsets stay valid.
 */
export function injectElementIds(html: string, offsetMap: OffsetMap | null): string {
  if (!offsetMap || offsetMap.elements.length === 0) return html;
  type Insertion = { pos: number; text: string };
  const inserts: Insertion[] = [];
  for (const el of offsetMap.elements) {
    if (el.endOffset <= el.startOffset) continue;
    const insertPos = el.startOffset + 1 + el.tagName.length;
    if (insertPos >= html.length) continue;
    const next = html[insertPos];
    // Sanity: must be at the boundary right after the source tag name.
    if (
      next !== ' ' &&
      next !== '\t' &&
      next !== '\n' &&
      next !== '\r' &&
      next !== '/' &&
      next !== '>'
    ) {
      continue;
    }
    inserts.push({ pos: insertPos, text: ` data-finesse-id="${el.elementId}"` });
  }
  if (inserts.length === 0) return html;
  inserts.sort((a, b) => a.pos - b.pos);
  const pieces: string[] = [];
  let cursor = 0;
  for (const ins of inserts) {
    if (ins.pos < cursor) continue;
    pieces.push(html.slice(cursor, ins.pos));
    pieces.push(ins.text);
    cursor = ins.pos;
  }
  pieces.push(html.slice(cursor));
  return pieces.join('');
}

const EARLY_ERROR_BRIDGE = `<script>
(function(){
  function send(payload){
    try {
      window.parent.postMessage(Object.assign({ type: 'runtimeError', source: 'page' }, payload), '*');
    } catch (_) {}
  }
  window.addEventListener('error', function(e){
    send({
      message: e.message || 'Script error',
      filename: e.filename || undefined,
      lineno: e.lineno || undefined,
      colno: e.colno || undefined,
      stack: e.error && e.error.stack ? String(e.error.stack) : undefined
    });
  });
  window.addEventListener('unhandledrejection', function(e){
    var reason = e.reason;
    send({
      message: 'Unhandled promise rejection: ' + (reason && reason.message ? reason.message : String(reason)),
      stack: reason && reason.stack ? String(reason.stack) : undefined
    });
  });
})();
</script>`;
const RUNTIME_SCRIPT_TAG = '<script src="/__edit/runtime.js"></script>';

function jsonForScript(value: unknown): string {
  // Escape "</" sequences inside JSON strings so a payload can't break out of <script>.
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

export function injectInstrumentation(html: string, payload: InjectionPayload): string {
  const initScript = `<script>window.__FINESSE__ = ${jsonForScript(payload)};</script>`;
  const injected = `\n${initScript}\n${EARLY_ERROR_BRIDGE}\n${RUNTIME_SCRIPT_TAG}\n`;
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
