import { describe, expect, it, vi } from 'vitest';
import {
  createThreadEngine,
  type ThreadRunContext,
} from '../src/host/agent/threads/engine';
import { anchorFromSelection, foldPrompts } from '../src/host/agent/threads/types';
import type { ElementAnchor } from '../src/host/agent/threads/types';

function anchor(domPath = 'body > h1'): ElementAnchor {
  return { path: 'src/page.html', domPath, selectorHints: [], tagName: 'h1', textPreview: 'Hi' };
}

/** Drain a few microtask turns so abort→reject→pump chains settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Deterministic id/clock so tests are stable. */
function deterministicDeps() {
  let idN = 0;
  let clock = 1000;
  return {
    genId: () => `id-${idN++}`,
    now: () => clock++,
  };
}

/**
 * A controllable runThread: each call parks on a promise the test resolves,
 * so we can assert serialization and queue ordering deterministically.
 *
 * Abort-aware: when the run's signal aborts, the parked promise rejects with
 * an `AbortError`. This mirrors a real provider honoring the abort signal —
 * the engine frees the active slot only once the underlying run settles, which
 * is what keeps serialization honest for non-abortable providers too.
 */
function deferredRunner() {
  const calls: Array<{
    ctx: ThreadRunContext;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  const runThread = (ctx: ThreadRunContext) =>
    new Promise<void>((resolve, reject) => {
      const entry = { ctx, resolve, reject };
      calls.push(entry);
      ctx.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  return { calls, runThread };
}

describe('edit thread engine', () => {
  it('serializes runs FIFO — only one runs at a time', async () => {
    const { calls, runThread } = deferredRunner();
    const onChange = vi.fn();
    const engine = createThreadEngine({ runThread, onChange, ...deterministicDeps() });

    const a = engine.create({ anchor: anchor('body > a'), providerId: 'cursor', prompt: 'A' });
    const b = engine.create({ anchor: anchor('body > b'), providerId: 'cursor', prompt: 'B' });

    engine.run(a.id);
    engine.run(b.id);
    await Promise.resolve();

    // Only A is running; B waits in the queue.
    expect(calls).toHaveLength(1);
    expect(engine.get(a.id)!.status).toBe('running');
    expect(engine.get(b.id)!.status).toBe('queued');
    expect(engine.queuePositionOf(b.id)).toBe(1);

    // Finish A → B starts.
    calls[0].resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(engine.get(a.id)!.status).toBe('done');
    expect(engine.get(b.id)!.status).toBe('running');

    calls[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.get(b.id)!.status).toBe('done');
    expect(engine.isRunning()).toBe(false);
  });

  it('pause removes a queued thread from the run queue', async () => {
    const { calls, runThread } = deferredRunner();
    const engine = createThreadEngine({ runThread, onChange: () => {}, ...deterministicDeps() });

    const a = engine.create({ anchor: anchor(), providerId: 'cursor', prompt: 'A' });
    const b = engine.create({ anchor: anchor(), providerId: 'cursor', prompt: 'B' });
    engine.run(a.id);
    engine.run(b.id);
    await Promise.resolve();

    engine.pause(b.id);
    expect(engine.get(b.id)!.status).toBe('paused');
    expect(engine.queuePositionOf(b.id)).toBeUndefined();

    // Finishing A should NOT start B (it was paused out of the queue).
    calls[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(engine.isRunning()).toBe(false);
  });

  it('resume re-enqueues a paused thread', async () => {
    const { calls, runThread } = deferredRunner();
    const engine = createThreadEngine({ runThread, onChange: () => {}, ...deterministicDeps() });
    const a = engine.create({ anchor: anchor(), providerId: 'cursor', prompt: 'A' });
    engine.run(a.id);
    await Promise.resolve();
    engine.pause(a.id);
    expect(engine.get(a.id)!.status).toBe('paused');
    // Let the aborted run reject and free the active slot.
    await flushMicrotasks();

    engine.resume(a.id);
    await flushMicrotasks();
    // The paused run's epoch was bumped; a fresh run is now in flight.
    expect(engine.get(a.id)!.status).toBe('running');
    expect(calls).toHaveLength(2);
  });

  it('drops late sink callbacks from a superseded (restarted) run via epoch guard', async () => {
    const { calls, runThread } = deferredRunner();
    const engine = createThreadEngine({ runThread, onChange: () => {}, ...deterministicDeps() });
    const a = engine.create({ anchor: anchor(), providerId: 'cursor', prompt: 'A' });
    engine.run(a.id);
    await Promise.resolve();

    const staleEpoch = calls[0].ctx.epoch;

    // Restart bumps the epoch, aborts the in-flight run, and re-enqueues.
    engine.restart(a.id);
    await flushMicrotasks();

    // A late callback from the first run must be ignored.
    engine.appendRunLog(a.id, staleEpoch, 'STALE OUTPUT');
    expect(engine.get(a.id)!.runLogTail).toBe('');

    // The new run's callbacks land.
    const freshEpoch = calls[calls.length - 1].ctx.epoch;
    expect(freshEpoch).not.toBe(staleEpoch);
    engine.appendRunLog(a.id, freshEpoch, 'fresh');
    expect(engine.get(a.id)!.runLogTail).toBe('fresh');
  });

  it('a superseded run does not flip status to done/error when it finally settles', async () => {
    const { calls, runThread } = deferredRunner();
    const engine = createThreadEngine({ runThread, onChange: () => {}, ...deterministicDeps() });
    const a = engine.create({ anchor: anchor(), providerId: 'cursor', prompt: 'A' });
    engine.run(a.id);
    await Promise.resolve();

    engine.restart(a.id); // bumps epoch + aborts; the original run is now stale
    await flushMicrotasks();

    // The original (stale) run rejected via abort — must not have flipped the
    // thread to error/done; the fresh run is what's now in flight.
    expect(engine.get(a.id)!.status).toBe('running');

    // The fresh run settles → done.
    calls[calls.length - 1].resolve();
    await flushMicrotasks();
    expect(engine.get(a.id)!.status).toBe('done');
  });

  it('records run failures as error status with formatted message', async () => {
    const calls: Array<{ reject: (e: unknown) => void }> = [];
    const runThread = (_ctx: ThreadRunContext) =>
      new Promise<void>((_resolve, reject) => calls.push({ reject }));
    const engine = createThreadEngine({
      runThread,
      onChange: () => {},
      formatError: (err) => ({ message: String(err), kind: 'auth' }),
      ...deterministicDeps(),
    });
    const a = engine.create({ anchor: anchor(), providerId: 'claude-code', prompt: 'A' });
    engine.run(a.id);
    await Promise.resolve();
    calls[0].reject(new Error('nope'));
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.get(a.id)!.status).toBe('error');
    expect(engine.get(a.id)!.error).toContain('nope');
    expect(engine.get(a.id)!.errorKind).toBe('auth');
  });

  it('aborts the active run on pause', async () => {
    const seen: AbortSignal[] = [];
    const runThread = (ctx: ThreadRunContext) => {
      seen.push(ctx.signal);
      return new Promise<void>(() => {}); // never settles on its own
    };
    const engine = createThreadEngine({ runThread, onChange: () => {}, ...deterministicDeps() });
    const a = engine.create({ anchor: anchor(), providerId: 'claude-code', prompt: 'A' });
    engine.run(a.id);
    await Promise.resolve();
    expect(seen[0].aborted).toBe(false);
    engine.pause(a.id);
    expect(seen[0].aborted).toBe(true);
  });
});

describe('thread prompt + anchor helpers', () => {
  it('folds initial prompt and steers into one instruction', () => {
    expect(foldPrompts([])).toBe('');
    expect(
      foldPrompts([
        { id: '1', text: 'Make it blue', at: 0, midRun: false },
      ]),
    ).toBe('Make it blue');
    const folded = foldPrompts([
      { id: '1', text: 'Make it blue', at: 0, midRun: false },
      { id: '2', text: 'and bigger', at: 1, midRun: true },
    ]);
    expect(folded).toContain('Make it blue');
    expect(folded).toContain('Additional instruction 1:');
    expect(folded).toContain('and bigger');
  });

  it('builds a durable anchor from a selection snapshot, seeding the fast-path cache', () => {
    const anchorOut = anchorFromSelection(
      {
        documentVersion: 9,
        elementId: 42,
        tagName: 'button',
        domPath: 'body > button',
        selectorHints: ['.cta'],
        classList: ['cta'],
        classCatalog: ['cta'],
        classRules: {},
        textPreview: 'Buy',
        outerHtmlPreview: '<button class="cta">Buy</button>',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        styles: {
          inlineStyle: null,
          computed: {} as never,
        },
      },
      'src/index.html',
    );
    expect(anchorOut.path).toBe('src/index.html');
    expect(anchorOut.domPath).toBe('body > button');
    expect(anchorOut.lastKnownElementId).toBe(42);
    expect(anchorOut.lastKnownVersion).toBe(9);
  });
});
