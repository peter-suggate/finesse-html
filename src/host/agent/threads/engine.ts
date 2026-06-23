import type { AgentProviderId } from '../types';
import {
  capRunLog,
  foldPrompts,
  type EditThread,
  type ElementAnchor,
  type SteeringMessage,
} from './types';

/** Context handed to the run callback for a single dequeued run. */
export interface ThreadRunContext {
  thread: EditThread;
  /** The run generation. Sink callbacks must tag writes with this. */
  epoch: number;
  /** Aborted when the run is paused/restarted (best-effort per provider). */
  signal: AbortSignal;
  /** The instruction to send the provider (folded prompt history). */
  prompt: string;
}

export interface ThreadEngineOpts {
  /**
   * Perform the actual provider run. Resolve on success, throw on failure.
   * The engine serializes calls — at most one runs at a time.
   */
  runThread: (ctx: ThreadRunContext) => Promise<void>;
  /** Called whenever any thread's observable state changes. */
  onChange: () => void;
  /** Map a thrown run error to a stored message + kind. */
  formatError?: (err: unknown) => { message: string; kind?: 'auth' };
  /** Injectable for tests. Defaults to `crypto.randomUUID()`. */
  genId?: () => string;
  /** Injectable for tests. Defaults to `Date.now()`. */
  now?: () => number;
  /** Injectable for tests. Defaults to `new AbortController()`. */
  createAbort?: () => AbortController;
}

export interface CreateThreadInput {
  anchor: ElementAnchor;
  providerId: AgentProviderId;
  prompt: string;
}

/**
 * Serialized, epoch-guarded run engine for lingering edit threads.
 *
 * Holds the thread set and a FIFO run queue, guaranteeing exactly one
 * provider run touches the document at a time. Pause/resume/restart and
 * mid-run steering are expressed as queue + epoch transitions; the `runEpoch`
 * guard lets the engine *behave* as if an uncancellable provider run were
 * cancelled by dropping its late callbacks.
 */
export interface ThreadEngine {
  /** Create a new idle thread (does not enqueue it). */
  create(input: CreateThreadInput): EditThread;
  /** Insert a restored thread verbatim (status forced non-running). */
  hydrate(thread: EditThread): void;
  /** Append a steering instruction to an existing thread. */
  steer(threadId: string, text: string): void;
  /** Enqueue a thread to run. No-op if already running/queued. */
  run(threadId: string): void;
  /** Pause a queued/running thread; retains all state. */
  pause(threadId: string): void;
  /** Resume a paused thread by re-enqueuing it. */
  resume(threadId: string): void;
  /** Restart: invalidate any in-flight run and re-enqueue. */
  restart(threadId: string): void;
  /** Permanently drop a thread. */
  remove(threadId: string): void;
  /** Epoch-guarded append to a thread's run log. */
  appendRunLog(threadId: string, epoch: number, text: string): void;
  /** Set a thread's status directly (e.g. mark `stale` after a failed re-anchor). */
  setStatus(threadId: string, status: EditThread['status'], error?: string): void;
  get(threadId: string): EditThread | undefined;
  /** All threads, in insertion order. */
  all(): EditThread[];
  activeId(): string | null;
  /** Any run in flight. */
  isRunning(): boolean;
  /** 1-based position in the run queue, or undefined if not queued. */
  queuePositionOf(threadId: string): number | undefined;
}

export function createThreadEngine(opts: ThreadEngineOpts): ThreadEngine {
  const genId = opts.genId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());
  const createAbort = opts.createAbort ?? (() => new AbortController());
  const formatError: (err: unknown) => { message: string; kind?: 'auth' } =
    opts.formatError ??
    ((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
    }));

  // Insertion-ordered so the UI roster and pins keep a stable order.
  const threads = new Map<string, EditThread>();
  const runQueue: string[] = [];
  let activeId: string | null = null;
  let activeAbort: AbortController | null = null;

  function notify(): void {
    opts.onChange();
  }

  function steerMessage(text: string, midRun: boolean): SteeringMessage {
    return { id: genId(), text, at: now(), midRun };
  }

  function create(input: CreateThreadInput): EditThread {
    const thread: EditThread = {
      id: genId(),
      anchor: input.anchor,
      status: 'idle',
      providerId: input.providerId,
      prompts: [steerMessage(input.prompt, false)],
      runLogTail: '',
      createdAt: now(),
      runEpoch: 0,
    };
    threads.set(thread.id, thread);
    notify();
    return thread;
  }

  function hydrate(thread: EditThread): void {
    // Restored threads never come back mid-run; collapse transient states.
    const status =
      thread.status === 'running' || thread.status === 'queued'
        ? 'idle'
        : thread.status;
    threads.set(thread.id, { ...thread, status });
  }

  function steer(threadId: string, text: string): void {
    const t = threads.get(threadId);
    if (!t) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    t.prompts.push(steerMessage(trimmed, t.status === 'running'));
    notify();
  }

  function run(threadId: string): void {
    const t = threads.get(threadId);
    if (!t) return;
    if (t.status === 'running' || runQueue.includes(threadId)) return;
    t.status = 'queued';
    t.runEpoch++;
    t.error = undefined;
    t.errorKind = undefined;
    runQueue.push(threadId);
    notify();
    void pump();
  }

  function dropFromQueue(threadId: string): void {
    const i = runQueue.indexOf(threadId);
    if (i >= 0) runQueue.splice(i, 1);
  }

  function pause(threadId: string): void {
    const t = threads.get(threadId);
    if (!t) return;
    if (t.status !== 'running' && t.status !== 'queued') return;
    dropFromQueue(threadId);
    t.status = 'paused';
    t.runEpoch++; // invalidate any in-flight callbacks for this thread
    if (activeId === threadId) activeAbort?.abort();
    notify();
  }

  function resume(threadId: string): void {
    const t = threads.get(threadId);
    if (!t || t.status !== 'paused') return;
    run(threadId);
  }

  function restart(threadId: string): void {
    const t = threads.get(threadId);
    if (!t) return;
    dropFromQueue(threadId);
    t.runEpoch++;
    if (activeId === threadId) activeAbort?.abort();
    t.runLogTail = '';
    t.status = 'queued';
    t.error = undefined;
    t.errorKind = undefined;
    runQueue.push(threadId);
    notify();
    void pump();
  }

  function remove(threadId: string): void {
    const t = threads.get(threadId);
    if (!t) return;
    dropFromQueue(threadId);
    t.runEpoch++;
    if (activeId === threadId) activeAbort?.abort();
    threads.delete(threadId);
    notify();
  }

  function appendRunLog(threadId: string, epoch: number, text: string): void {
    const t = threads.get(threadId);
    if (!t || t.runEpoch !== epoch || !text) return;
    t.runLogTail = capRunLog(t.runLogTail + text);
    notify();
  }

  function setStatus(
    threadId: string,
    status: EditThread['status'],
    error?: string,
  ): void {
    const t = threads.get(threadId);
    if (!t) return;
    t.status = status;
    t.error = error;
    notify();
  }

  async function pump(): Promise<void> {
    if (activeId !== null) return;
    // Skip threads that were paused/removed while queued.
    let nextId: string | undefined;
    for (;;) {
      nextId = runQueue.shift();
      if (nextId === undefined) return;
      const candidate = threads.get(nextId);
      if (candidate && candidate.status === 'queued') break;
    }
    const thread = threads.get(nextId)!;
    const epoch = thread.runEpoch;
    activeId = nextId;
    activeAbort = createAbort();
    thread.status = 'running';
    thread.lastRunAt = now();
    notify();

    const ctx: ThreadRunContext = {
      thread,
      epoch,
      signal: activeAbort.signal,
      prompt: foldPrompts(thread.prompts),
    };
    const aborted = (): boolean => activeAbort?.signal.aborted ?? false;

    try {
      await opts.runThread(ctx);
      // Settle only if this run is still the current generation and wasn't
      // superseded by a pause/restart/remove (which bump runEpoch).
      if (thread.runEpoch === epoch) {
        thread.status = 'done';
        thread.error = undefined;
        thread.errorKind = undefined;
      }
    } catch (err) {
      if (thread.runEpoch === epoch && !aborted()) {
        const { message, kind } = formatError(err);
        thread.status = 'error';
        thread.error = message;
        thread.errorKind = kind;
      }
    } finally {
      activeId = null;
      activeAbort = null;
      notify();
      void pump();
    }
  }

  return {
    create,
    hydrate,
    steer,
    run,
    pause,
    resume,
    restart,
    remove,
    appendRunLog,
    setStatus,
    get: (id) => threads.get(id),
    all: () => Array.from(threads.values()),
    activeId: () => activeId,
    isRunning: () => activeId !== null,
    queuePositionOf: (id) => {
      const i = runQueue.indexOf(id);
      return i >= 0 ? i + 1 : undefined;
    },
  };
}
