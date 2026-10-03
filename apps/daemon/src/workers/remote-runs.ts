import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  WORKER_RUN_ENV_KEYS,
  WORKER_RUN_EVENTS,
  WORKER_TRANSFER_EXCLUDED_DIRS,
  WORKER_TRANSFER_MAX_FILE_BYTES,
  WORKER_TRANSFER_NOT_COPIED_LIMIT,
  type WorkerRunConflict,
  type WorkerRunExitRequest,
  type WorkerRunKillEvent,
  type WorkerRunOutputChunk,
  type WorkerRunStartEvent,
  type WorkerRunStdinEndEvent,
  type WorkerRunStdinEvent,
  type WorkerRunTransferSummary,
} from '@open-design/contracts';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Runs whose agent process lives on a person's worker.
 *
 * The server keeps owning the run; only the process moves. `spawn` returns a
 * stand-in with the shape of a `ChildProcess` (stdout/stderr streams, stdin,
 * `exit`/`close`, `kill`), so the chat-run launcher feeds the worker's output
 * through exactly the parsers and finish logic a local agent gets.
 *
 * Invariant: a run's output, exit and project files are accepted only from
 * the person whose worker the run was handed to, and only until it has
 * exited. Its project is served to that person only for the same window.
 */

/**
 * The variables of a run's environment a worker may receive: only those the
 * agent needs to call back into the server for this run. Everything else,
 * provider credentials included, stays on the server.
 */
export function workerRunEnv(env: NodeJS.ProcessEnv): NonNullable<WorkerRunStartEvent['env']> {
  const picked: NonNullable<WorkerRunStartEvent['env']> = {};
  for (const key of WORKER_RUN_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string') picked[key] = value;
  }
  return picked;
}

/**
 * The working-directory identity a resumable agent session is stored under
 * when it ran on `person`'s worker. It differs from the server's own, so
 * the server never resumes a session that lives on a PC, or the reverse.
 */
export function workerAgentSessionCwd(person: string, projectDir: string): string {
  return `worker:${person}:${projectDir}`;
}

/** Exit code reported when the worker could not start the agent at all. */
const WORKER_SPAWN_FAILED_EXIT_CODE = 127;

/** A run the server ended before its worker reported the exit ends as killed. */
const RELEASED_RESULT: WorkerRunExitRequest = { code: null, signal: 'SIGKILL' };

const WORKER_DISCONNECTED_MESSAGE = (person: string) =>
  `${person}'s worker disconnected before the run finished. Changes the agent had not yet sent back were not saved.`;

export class WorkerOfflineError extends Error {
  readonly code = 'WORKER_OFFLINE';
  constructor(readonly person: string) {
    super(`${person}'s worker is offline. Start \`od worker\` on that PC, or run on the server instead.`);
    this.name = 'WorkerOfflineError';
  }
}

/** The `ChildProcess` surface the chat-run launcher uses. */
export interface RemoteAgentProcess extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** A pipe to the agent's stdin; `null` unless the run was started with `stdin: 'pipe'`. */
  readonly stdin: Writable | null;
  /** Never set: the process is on another machine. */
  readonly pid: undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  /**
   * How the run's project travelled; `null` for a run without a project.
   * Complete once the process emits `transfer`, just before `close`.
   */
  readonly transfer: WorkerRunTransferSummary | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RemoteRunDispatcher {
  /** Hands the run to `person`'s worker. Throws `WorkerOfflineError` when it is not connected. */
  spawn(person: string, request: WorkerRunStartEvent): RemoteAgentProcess;
  /** Output the worker reported. False when `person` does not own a live run `runId`. */
  output(person: string, runId: string, chunks: WorkerRunOutputChunk[]): boolean;
  /** The worker reported the process ended. False when `person` does not own a live run `runId`. */
  exit(person: string, runId: string, result: WorkerRunExitRequest): boolean;
  /**
   * The server-side project directory of live run `runId`, for `person`'s
   * worker to download or send changes to. `null` when `person` does not own
   * a live run `runId` or the run has no project.
   */
  projectDir(person: string, runId: string): string | null;
  /** The ids of the runs live on `person`'s worker. */
  liveRunIds(person: string): string[];
  /**
   * The server has ended run `runId` (it reached a terminal state). If the
   * worker has not reported its exit yet, the run stops being live now: its
   * process stand-in ends as killed, and the worker's late changes and exit
   * are refused, so nothing it sends lands after the project was released.
   */
  release(runId: string): void;
  /** A project path the server left out of live run `runId`'s copy. False when `person` does not own it. */
  noteNotCopied(person: string, runId: string, projectPath: string): boolean;
  /** What applying live run `runId`'s changes left for review. False when `person` does not own it. */
  noteChangesApplied(
    person: string,
    runId: string,
    applied: { conflicts: WorkerRunConflict[]; notSent: string[] },
  ): boolean;
}

/**
 * What a worker run's project transfer has left out or held back so far.
 * Repeated reports (a retried download or upload) are recorded once.
 */
class TransferRecord {
  private readonly notCopied = new Set<string>();
  private readonly notSentBack = new Set<string>();
  private readonly conflicts = new Map<string, WorkerRunConflict>();

  noteNotCopied(projectPath: string): void {
    this.notCopied.add(projectPath);
  }

  noteChangesApplied({ conflicts, notSent }: { conflicts: WorkerRunConflict[]; notSent: string[] }): void {
    for (const conflict of conflicts) this.conflicts.set(conflict.path, conflict);
    for (const projectPath of notSent) this.notSentBack.add(projectPath);
  }

  summary(): WorkerRunTransferSummary {
    const conflicts = [...this.conflicts.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
      excludedDirs: [...WORKER_TRANSFER_EXCLUDED_DIRS],
      maxFileBytes: WORKER_TRANSFER_MAX_FILE_BYTES,
      notCopied: [...this.notCopied].sort().slice(0, WORKER_TRANSFER_NOT_COPIED_LIMIT),
      notCopiedTotal: this.notCopied.size,
      notSentBack: [...this.notSentBack].sort(),
      conflicts,
      needsReview: conflicts.length > 0,
    };
  }
}

/**
 * The note a finished worker run adds to its reply, or `null` when nothing
 * was left behind and nothing conflicted.
 */
export function workerTransferNotice(summary: WorkerRunTransferSummary | null): string | null {
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.needsReview) {
    lines.push('**Needs review:** these files changed on the server while the agent was working on them. The server\'s version was kept.');
    for (const conflict of summary.conflicts) {
      lines.push(conflict.agentCopy
        ? `- \`${conflict.path}\`: the agent's version is saved as \`${conflict.agentCopy}\``
        : `- \`${conflict.path}\`: the agent deleted it; it was not deleted`);
    }
  }
  const megabytes = Math.round(summary.maxFileBytes / (1024 * 1024));
  if (summary.notCopiedTotal > 0) {
    if (lines.length) lines.push('');
    lines.push(`Not copied to the worker (${summary.excludedDirs.join(' and ')} folders, and files over ${megabytes} MB, never are):`);
    for (const projectPath of summary.notCopied) lines.push(`- \`${projectPath}\``);
    const more = summary.notCopiedTotal - summary.notCopied.length;
    if (more > 0) lines.push(`- and ${more} more`);
  }
  if (summary.notSentBack.length > 0) {
    if (lines.length) lines.push('');
    lines.push(`Not sent back from the worker, because they are over ${megabytes} MB:`);
    for (const projectPath of summary.notSentBack) lines.push(`- \`${projectPath}\``);
  }
  return lines.length ? `\n\n${lines.join('\n')}\n` : null;
}

class RemoteProcess extends EventEmitter implements RemoteAgentProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly transferRecord: TransferRecord | null;

  constructor(
    private readonly runId: string,
    private readonly send: (event: string, data: unknown) => boolean,
    pipeStdin: boolean,
    hasProject: boolean,
  ) {
    super();
    this.stdin = pipeStdin ? this.createStdin() : null;
    this.transferRecord = hasProject ? new TransferRecord() : null;
  }

  get transfer(): WorkerRunTransferSummary | null {
    return this.transferRecord?.summary() ?? null;
  }

  private createStdin(): Writable {
    const runId = this.runId;
    const send = this.send;
    return new Writable({
      decodeStrings: false,
      write(chunk: string | Buffer, _encoding, callback) {
        const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const event: WorkerRunStdinEvent = { runId, data };
        // Bytes for a worker that went away are dropped, not raised: a stdin
        // 'error' nobody listens for would take the daemon down, and the run's
        // own end is decided by its exit, not by its stdin.
        send(WORKER_RUN_EVENTS.stdin, event);
        callback();
      },
      final(callback) {
        const event: WorkerRunStdinEndEvent = { runId };
        send(WORKER_RUN_EVENTS.stdinEnd, event);
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    const event: WorkerRunKillEvent = { runId: this.runId, signal: String(signal) };
    const delivered = this.send(WORKER_RUN_EVENTS.kill, event);
    if (delivered) this.killed = true;
    return delivered;
  }

  write(chunks: WorkerRunOutputChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.stream === 'stdout') this.stdout.write(chunk.data);
      else if (chunk.stream === 'stderr') this.stderr.write(chunk.data);
    }
  }

  /** Ends the process the way Node does: `exit`, then `close` once stdout and stderr have drained. */
  end(result: WorkerRunExitRequest): void {
    if (result.error) this.stderr.write(`${result.error}\n`);
    const code = result.error ? WORKER_SPAWN_FAILED_EXIT_CODE : result.code;
    const signal = result.error ? null : ((result.signal as NodeJS.Signals | null) ?? null);
    this.exitCode = code;
    this.signalCode = code === null ? signal : null;
    this.stdin?.destroy();
    this.emit('exit', this.exitCode, this.signalCode);
    const drained = [this.stdout, this.stderr].map((stream) => new Promise<void>((resolve) => {
      stream.once('end', resolve);
      stream.end();
      // Nobody reading must not hold `close` back.
      if (stream.readableFlowing !== true) stream.resume();
    }));
    void Promise.all(drained).then(() => {
      const transfer = this.transfer;
      if (transfer) this.emit('transfer', transfer);
      this.emit('close', this.exitCode, this.signalCode);
    });
  }
}

export function createRemoteRunDispatcher({ registry }: { registry: WorkerRegistry }): RemoteRunDispatcher {
  const live = new Map<string, { person: string; process: RemoteProcess; projectDir: string | null }>();

  // A worker that is gone cannot report its runs' exit, so the server ends
  // them: the run fails and whatever it held, the project included, is released.
  registry.onWorkerGone((person) => {
    for (const [runId, entry] of [...live]) {
      if (entry.person !== person) continue;
      live.delete(runId);
      entry.process.end({ code: null, signal: null, error: WORKER_DISCONNECTED_MESSAGE(person) });
    }
  });

  const owned = (person: string, runId: string) => {
    const entry = live.get(runId);
    return entry && entry.person === person ? entry : undefined;
  };

  return {
    spawn(person, request) {
      const process = new RemoteProcess(
        request.runId,
        (event, data) => registry.send(person, event, data),
        request.stdin === 'pipe',
        Boolean(request.project),
      );
      if (!registry.send(person, WORKER_RUN_EVENTS.start, request)) throw new WorkerOfflineError(person);
      live.set(request.runId, { person, process, projectDir: request.project?.dir ?? null });
      return process;
    },
    output(person, runId, chunks) {
      const entry = owned(person, runId);
      if (!entry) return false;
      entry.process.write(chunks);
      return true;
    },
    exit(person, runId, result) {
      const entry = owned(person, runId);
      if (!entry) return false;
      live.delete(runId);
      entry.process.end(result);
      return true;
    },
    projectDir(person, runId) {
      return owned(person, runId)?.projectDir ?? null;
    },
    liveRunIds(person) {
      return [...live].filter(([, entry]) => entry.person === person).map(([runId]) => runId);
    },
    release(runId) {
      const entry = live.get(runId);
      if (!entry) return;
      live.delete(runId);
      // The worker may not have heard yet; the run is over either way.
      entry.process.kill('SIGKILL');
      entry.process.end(RELEASED_RESULT);
    },
    noteNotCopied(person, runId, projectPath) {
      const record = owned(person, runId)?.process.transferRecord;
      record?.noteNotCopied(projectPath);
      return Boolean(record);
    },
    noteChangesApplied(person, runId, applied) {
      const record = owned(person, runId)?.process.transferRecord;
      record?.noteChangesApplied(applied);
      return Boolean(record);
    },
  };
}
