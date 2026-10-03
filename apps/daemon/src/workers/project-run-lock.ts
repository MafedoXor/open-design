/**
 * Invariant: while a run on a person's worker is active in a project, no other
 * run starts in that project, and a worker run never starts into a project
 * that has an active run.
 *
 * A worker run edits a copy of the project and writes its changes back when it
 * ends; a second writer in the meantime would be overwritten or overwrite it.
 * Server-only runs keep sharing a project as before.
 *
 * The lock is not stored: it is the project's set of active runs, so it is
 * released by every way a run ends (finish, failure, cancel, worker gone).
 */

export interface ProjectRunLock {
  runId: string;
  /** The person whose worker holds the project, or `null` when the holder runs on the server. */
  workerPerson: string | null;
}

export class ProjectBusyError extends Error {
  readonly code = 'PROJECT_BUSY';
  constructor(readonly lock: { runId: string; workerPerson?: string | null }) {
    super(
      lock.workerPerson
        ? `This project is busy: a run on ${lock.workerPerson}'s worker is still active. Wait for it to finish or stop it first.`
        : 'This project is busy: another run is still active. Wait for it to finish or stop it first.',
    );
    this.name = 'ProjectBusyError';
  }
}

export function findProjectRunLock(input: {
  /** The project's non-terminal runs. */
  activeRuns: ReadonlyArray<{ id: string; workerPerson?: string | null | undefined }>;
  /** The worker the new run targets, `null` when it runs on the server. */
  newRunWorkerPerson: string | null;
  /** The new run's own record, which never blocks itself. */
  excludeRunId: string;
}): ProjectRunLock | null {
  for (const run of input.activeRuns) {
    if (run.id === input.excludeRunId) continue;
    if (input.newRunWorkerPerson || run.workerPerson) {
      return { runId: run.id, workerPerson: run.workerPerson ?? null };
    }
  }
  return null;
}
