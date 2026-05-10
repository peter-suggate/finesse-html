import { describe, expect, it } from 'vitest';
import { escapeForJsTemplate } from '../src/host/jsTemplateEscape';

describe('escapeForJsTemplate', () => {
  it('passes ordinary text through unchanged', () => {
    expect(escapeForJsTemplate('Hello world')).toBe('Hello world');
    expect(escapeForJsTemplate('<p>html</p>')).toBe('<p>html</p>');
  });

  it('escapes a backtick', () => {
    expect(escapeForJsTemplate('a`b')).toBe('a\\`b');
  });

  it('escapes a backslash', () => {
    expect(escapeForJsTemplate('a\\b')).toBe('a\\\\b');
  });

  it('escapes ${ but leaves a lone $ alone', () => {
    expect(escapeForJsTemplate('cost: $5')).toBe('cost: $5');
    expect(escapeForJsTemplate('Hello ${name}')).toBe('Hello \\${name}');
  });

  it('round-trips through eval as a template literal', () => {
    const samples = [
      'plain',
      'with `backtick`',
      'with \\backslash',
      'Hello ${name}!',
      'mix: $5 ${dollar} `tick` \\slash',
    ];
    for (const s of samples) {
      const escaped = escapeForJsTemplate(s);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const evaluated = new Function(`return \`${escaped}\`;`)();
      expect(evaluated).toBe(s);
    }
  });
});
