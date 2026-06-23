import { describe, expect, it } from 'vitest';
import { loadThreads, persistThreads, type ThreadStorage } from '../src/host/agent/threads/store';
import type { EditThread } from '../src/host/agent/threads/types';

/** In-memory Memento stand-in. */
function fakeStorage(): ThreadStorage & { dump: Record<string, unknown> } {
  const dump: Record<string, unknown> = {};
  return {
    dump,
    get<T>(key: string): T | undefined {
      return dump[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) delete dump[key];
      else dump[key] = value;
    },
  };
}

function thread(over: Partial<EditThread> = {}): EditThread {
  return {
    id: 'id-1',
    anchor: {
      path: 'src/page.html',
      domPath: 'body > h1',
      selectorHints: ['#title'],
      tagName: 'h1',
      textPreview: 'Hello',
    },
    status: 'done',
    providerId: 'cursor',
    prompts: [{ id: 'p1', text: 'Make it bold', at: 1, midRun: false }],
    runLogTail: 'done',
    createdAt: 1,
    runEpoch: 2,
    ...over,
  };
}

describe('edit thread persistence', () => {
  it('round-trips threads for a path', async () => {
    const storage = fakeStorage();
    const t = thread();
    await persistThreads(storage, 'src/page.html', [t]);
    const loaded = loadThreads(storage, 'src/page.html');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('id-1');
    expect(loaded[0].anchor.domPath).toBe('body > h1');
    expect(loaded[0].prompts[0].text).toBe('Make it bold');
  });

  it('only persists threads whose anchor path matches', async () => {
    const storage = fakeStorage();
    const a = thread({ id: 'a', anchor: { ...thread().anchor, path: 'src/page.html' } });
    const b = thread({ id: 'b', anchor: { ...thread().anchor, path: 'src/other.html' } });
    await persistThreads(storage, 'src/page.html', [a, b]);
    expect(loadThreads(storage, 'src/page.html').map((t) => t.id)).toEqual(['a']);
    expect(loadThreads(storage, 'src/other.html')).toEqual([]);
  });

  it('collapses transient running/queued to idle on save and load', async () => {
    const storage = fakeStorage();
    await persistThreads(storage, 'src/page.html', [
      thread({ id: 'r', status: 'running' }),
      thread({ id: 'q', status: 'queued' }),
      thread({ id: 'p', status: 'paused' }),
    ]);
    const loaded = loadThreads(storage, 'src/page.html');
    const byId = Object.fromEntries(loaded.map((t) => [t.id, t.status]));
    expect(byId.r).toBe('idle');
    expect(byId.q).toBe('idle');
    expect(byId.p).toBe('paused');
  });

  it('clears storage when no threads remain for a path', async () => {
    const storage = fakeStorage();
    await persistThreads(storage, 'src/page.html', [thread()]);
    expect(loadThreads(storage, 'src/page.html')).toHaveLength(1);
    await persistThreads(storage, 'src/page.html', []);
    expect(loadThreads(storage, 'src/page.html')).toEqual([]);
  });

  it('ignores malformed stored entries', () => {
    const storage = fakeStorage();
    storage.dump['finesse.editThreads.v1:src/page.html'] = [
      { id: 'ok', anchor: { path: 'src/page.html', domPath: 'body', selectorHints: [], tagName: 'div', textPreview: '' }, status: 'idle', providerId: 'cursor', prompts: [], runLogTail: '', createdAt: 1, runEpoch: 0 },
      { broken: true },
      null,
    ];
    const loaded = loadThreads(storage, 'src/page.html');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ok');
  });
});
