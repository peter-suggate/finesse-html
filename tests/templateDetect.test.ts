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
    ['php / xml-pi', '<p><?= $name ?></p>'],
  ])('detects %s as a structural template', (_label, html) => {
    expect(detectTemplate(html)).toBe(true);
  });

  it('does NOT lock the whole file for ${...} interpolations', () => {
    expect(detectTemplate('<p>${name}</p>')).toBe(false);
  });

  it('uses caller-supplied patterns when provided', () => {
    expect(detectTemplate('<p>~~x~~</p>', [/~~[^~]*~~/])).toBe(true);
    expect(detectTemplate('<p>{{ x }}</p>', [/~~[^~]*~~/])).toBe(false);
  });

  it('exposes the default pattern set', () => {
    expect(defaultTemplatePatterns().length).toBeGreaterThan(0);
  });
});

describe('textHasTemplateToken', () => {
  it('matches structural patterns from the default set', () => {
    expect(textHasTemplateToken('hello {{x}}')).toBe(true);
    expect(textHasTemplateToken('hello x')).toBe(false);
  });

  it('always locks ${...} per text node, even with custom patterns', () => {
    expect(textHasTemplateToken('hello ${name}!')).toBe(true);
    expect(textHasTemplateToken('hello ${name}', [/~~[^~]*~~/])).toBe(true);
  });
});
