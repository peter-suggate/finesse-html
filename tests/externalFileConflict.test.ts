import { describe, expect, it } from 'vitest';
import { decideExternalFileConflict } from '../src/host/externalFileConflict';

describe('decideExternalFileConflict', () => {
  it('returns noop for a clean document when disk text matches', () => {
    expect(
      decideExternalFileConflict({
        diskText: '<p>same</p>',
        documentText: '<p>same</p>',
        isDirty: false,
      }),
    ).toEqual({
      action: 'noop',
      reason: 'text-matches',
      documentState: 'clean',
    });
  });

  it('prompts for a clean document when disk text changed', () => {
    expect(
      decideExternalFileConflict({
        diskText: '<p>from disk</p>',
        documentText: '<p>open doc</p>',
        isDirty: false,
      }),
    ).toEqual({
      action: 'prompt',
      reason: 'disk-text-differs',
      documentState: 'clean',
    });
  });

  it('prompts for a dirty document when disk text changed', () => {
    expect(
      decideExternalFileConflict({
        diskText: '<p>from disk</p>',
        documentText: '<p>unsaved doc</p>',
        isDirty: true,
      }),
    ).toEqual({
      action: 'prompt',
      reason: 'disk-text-differs',
      documentState: 'dirty',
    });
  });
});
