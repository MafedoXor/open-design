import type { ChatRunStatus } from '@open-design/contracts';

/**
 * A project is busy when the server would refuse a new run in it with
 * `PROJECT_BUSY`. This mirrors the daemon's rule (`findProjectRunLock` in
 * apps/daemon/src/workers/project-run-lock.ts): while a run on a person's
 * worker is active nothing else starts, and a run for a worker never starts
 * next to an active run. Server-only runs keep sharing a project.
 *
 * The busy state is read from the server's active runs, not from this
 * browser's memory, so it shows to everyone and survives a reload.
 */
export interface ProjectBusy {
  /** The person whose worker holds the project, or `null` when the holder runs on the server. */
  workerPerson: string | null;
}

const ACTIVE_STATUSES: ReadonlySet<ChatRunStatus> = new Set(['queued', 'running']);

export function projectBusyFromActiveRuns(
  runs: ReadonlyArray<{ status: ChatRunStatus; workerPerson?: string | null }>,
  /** The worker this browser's next run goes to, `null` when it runs on the server. */
  nextRunWorkerPerson: string | null,
): ProjectBusy | null {
  for (const run of runs) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    if (nextRunWorkerPerson || run.workerPerson) {
      return { workerPerson: run.workerPerson || null };
    }
  }
  return null;
}

