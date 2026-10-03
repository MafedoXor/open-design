import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  WORKER_RUN_EVENTS,
  type WorkerRunExitRequest,
  type WorkerRunKillEvent,
  type WorkerRunOutputChunk,
  type WorkerRunStartEvent,
  type WorkerRunStdinEndEvent,
  type WorkerRunStdinEvent,
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
 * Invariant: a run's output and exit are accepted only from the person whose
 * worker the run was handed to, and only until it has exited.
 */

/** Exit code reported when the worker could not start the agent at all. */
const WORKER_SPAWN_FAILED_EXIT_CODE = 127;

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
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RemoteRunDispatcher {
  /** Hands the run to `person`'s worker. Throws `WorkerOfflineError` when it is not connected. */
  spawn(person: string, request: WorkerRunStartEvent): RemoteAgentProcess;
  /** Output the worker reported. False when `person` does not own a live run `runId`. */
  output(person: string, runId: string, chunks: WorkerRunOutputChunk[]): boolean;
  /** The worker reported the process ended. False when `person` does not own a live run `runId`. */
  exit(person: string, runId: string, result: WorkerRunExitRequest): boolean;
}

class RemoteProcess extends EventEmitter implements RemoteAgentProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(
    private readonly runId: string,
    private readonly send: (event: string, data: unknown) => boolean,
    pipeStdin: boolean,
  ) {
    super();
    this.stdin = pipeStdin ? this.createStdin() : null;
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
    void Promise.all(drained).then(() => this.emit('close', this.exitCode, this.signalCode));
  }
}

export function createRemoteRunDispatcher({ registry }: { registry: WorkerRegistry }): RemoteRunDispatcher {
  const live = new Map<string, { person: string; process: RemoteProcess }>();

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
      );
      if (!registry.send(person, WORKER_RUN_EVENTS.start, request)) throw new WorkerOfflineError(person);
      live.set(request.runId, { person, process });
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
  };
}
