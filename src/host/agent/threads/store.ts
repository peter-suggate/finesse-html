import type { EditThread } from './types';

/**
 * Minimal key/value persistence surface. `vscode.Memento` satisfies this, and
 * tests can pass a plain in-memory fake.
 */
export interface ThreadStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const THREADS_KEY_PREFIX = 'finesse.editThreads.v1:';

function keyFor(relPath: string): string {
  return THREADS_KEY_PREFIX + relPath;
}

/** Fields persisted per thread. Transient run state is collapsed on save. */
type PersistedThread = EditThread;

/**
 * Prepare a thread for storage: never persist a transient `running`/`queued`
 * state (those don't survive a reload), and drop the in-flight epoch's meaning
 * by leaving the value as-is (it's only compared within a session).
 */
function toPersisted(thread: EditThread): PersistedThread {
  const status =
    thread.status === 'running' || thread.status === 'queued' ? 'idle' : thread.status;
  return { ...thread, status };
}

/**
 * Persist all threads for a source path. Threads are grouped by their anchor
 * path so reopening a preview for the same file restores them regardless of
 * which panel instance shows it.
 */
export async function persistThreads(
  storage: ThreadStorage,
  relPath: string,
  threads: EditThread[],
): Promise<void> {
  const forPath = threads.filter((t) => t.anchor.path === relPath).map(toPersisted);
  if (forPath.length === 0) {
    await storage.update(keyFor(relPath), undefined);
    return;
  }
  await storage.update(keyFor(relPath), forPath);
}

/** Load persisted threads for a source path. Returns [] when none stored. */
export function loadThreads(storage: ThreadStorage, relPath: string): EditThread[] {
  const raw = storage.get<PersistedThread[]>(keyFor(relPath));
  if (!Array.isArray(raw)) return [];
  // Defensive: collapse any stored transient state and ensure required fields.
  return raw
    .filter((t): t is EditThread => !!t && typeof t.id === 'string' && !!t.anchor)
    .map((t) => ({
      ...t,
      status: t.status === 'running' || t.status === 'queued' ? 'idle' : t.status,
    }));
}
