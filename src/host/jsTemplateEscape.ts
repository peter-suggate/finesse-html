/**
 * Escape a string so it can be safely spliced into the body of a JS/TS
 * template literal (between backticks). Backticks, backslashes, and the
 * `${` interpolation marker are each prefixed with a backslash. The
 * resulting source — when evaluated as a template literal — yields back
 * exactly the original input.
 */
export function escapeForJsTemplate(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\') {
      out += '\\\\';
      continue;
    }
    if (c === '`') {
      out += '\\`';
      continue;
    }
    if (c === '$' && input[i + 1] === '{') {
      out += '\\${';
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
