/**
 * Inline style state for one selected element.
 *
 * Pure helpers that read/parse a `style="…"` attribute string into a
 * Map<string, string>, write a mutation back, and serialise to a `style`
 * attribute value. Declaration order is preserved so unrelated declarations
 * survive a one-property edit.
 *
 * Removing a property leaves no trace; setting an empty value also removes.
 */

export type StyleMap = Map<string, string>;

const DECL_RE = /^\s*([a-zA-Z-][a-zA-Z0-9-]*)\s*:\s*(.+?)\s*$/;

export function parseStyleAttr(value: string | null): StyleMap {
  const map: StyleMap = new Map();
  if (!value) return map;
  for (const part of value.split(';')) {
    const m = DECL_RE.exec(part);
    if (!m) continue;
    map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
}

/**
 * Serialise to a single-line `style` attribute value. Empty map → empty string
 * (caller should then remove the attribute entirely rather than write `style=""`).
 */
export function serialiseStyleAttr(map: StyleMap): string {
  const parts: string[] = [];
  for (const [k, v] of map.entries()) {
    if (!v) continue;
    parts.push(`${k}: ${v}`);
  }
  return parts.join('; ');
}

export function withProperty(map: StyleMap, prop: string, value: string | null): StyleMap {
  const next = new Map(map);
  const key = prop.toLowerCase();
  if (value === null || value.trim() === '') {
    next.delete(key);
  } else {
    next.set(key, value.trim());
  }
  return next;
}

export function withProperties(
  map: StyleMap,
  props: Readonly<Record<string, string | null>>,
): StyleMap {
  let next = map;
  for (const [k, v] of Object.entries(props)) {
    next = withProperty(next, k, v);
  }
  return next;
}

/**
 * Convert a StyleMap into the `attrs` payload for an `editElementAttrs`
 * commit. If the resulting style attribute is empty, we emit `{ style: null }`
 * so the host removes the attribute rather than writing an empty `style=""`.
 */
export function attrsForStyleMap(map: StyleMap): Record<string, string | null> {
  const serialised = serialiseStyleAttr(map);
  return { style: serialised === '' ? null : serialised };
}
