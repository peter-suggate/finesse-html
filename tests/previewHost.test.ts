import { describe, expect, it } from 'vitest';
import { previewHostForDevServerUrl } from '../src/host/previewHost';

describe('previewHostForDevServerUrl', () => {
  it('preserves localhost for localhost dev-server previews', () => {
    expect(previewHostForDevServerUrl('http://localhost:3000')).toBe('localhost');
    expect(previewHostForDevServerUrl('http://localhost:3000/dashboard?tab=auth')).toBe(
      'localhost',
    );
  });

  it('keeps the default loopback host for non-localhost and invalid URLs', () => {
    expect(previewHostForDevServerUrl('http://127.0.0.1:3000')).toBe('127.0.0.1');
    expect(previewHostForDevServerUrl('https://example.test')).toBe('127.0.0.1');
    expect(previewHostForDevServerUrl('not a url')).toBe('127.0.0.1');
  });
});
