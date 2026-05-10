import { describe, expect, it } from 'vitest';
import {
  defaultTemplatePatterns,
  detectTemplate,
  textHasTemplateToken,
} from '../src/host/parse/templateDetect';

describe('detectTemplate', () => {
  it('returns false for plain HTML', () => {
    expect(detectTemplate('<html><body><p>hi</p></body></html>')).toBe(false);
  });

  it.each([
    ['handlebars / mustache', '<p>{{ name }}</p>'],
    ['jinja / liquid', '<p>{% if x %}y{% endif %}</p>'],
    ['ejs / erb', '<p><%= name %></p>'],
    ['template literal', '<p>${name}</p>'],
    ['php / xml-pi', '<p><?= $name ?></p>'],
  ])('detects %s', (_label, html) => {
    expect(detectTemplate(html)).toBe(true);
  });

  it('uses caller-supplied patterns when provided', () => {
    expect(detectTemplate('<p>~~x~~</p>', [/~~[^~]*~~/])).toBe(true);
    // Caller patterns replace defaults: standard handlebars no longer matches.
    expect(detectTemplate('<p>{{ x }}</p>', [/~~[^~]*~~/])).toBe(false);
  });

  it('exposes the default pattern set', () => {
    expect(defaultTemplatePatterns().length).toBeGreaterThan(0);
  });
});

describe('textHasTemplateToken', () => {
  it('matches against the supplied patterns only', () => {
    expect(textHasTemplateToken('hello {{x}}')).toBe(true);
    expect(textHasTemplateToken('hello x')).toBe(false);
  });
});
