import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKER_RUN_EVENTS,
  workerBridgeRunExitPath,
  workerBridgeRunOutputPath,
  type WorkerRunExitRequest,
  type WorkerRunKillEvent,
  type WorkerRunOutputChunk,
  type WorkerRunOutputRequest,
  type WorkerRunStartEvent,
  type WorkerRunStdinEvent,
} from '@open-design/contracts';

/**
 * The worker's side of a run: `od worker` received `run-start` on its
 * channel, starts the agent CLI on this PC, and posts its output back.
 *
 * Invariants:
 * - Output reaches the server in the order the agent wrote it, and the exit
 *   report is sent only after every output chunk before it was accepted.
 * - Each run gets its own empty temporary working directory, removed when the
 *   agent ends.
 * - The agent runs with this PC's own environment; the server sends none.
 */

export interface WorkerLaunch {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export type WorkerRunExecutorEvent =
  | { type: 'started'; runId: string; agentId: string }
  | { type: 'finished'; runId: string; result: WorkerRunExitRequest };

export interface WorkerRunExecutorOptions {
  serverUrl: string;
  token: string;
  /** How to start agent `agentId` with `args` on this PC; `null` when it is not installed. */
  resolveLaunch: (agentId: string, args: string[]) => WorkerLaunch | null;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: WorkerRunExecutorEvent) => void;
}

export interface WorkerRunExecutor {
  /** Feed every server event from the worker channel here. */
  handle: (event: string, data: unknown) => void;
  /** Terminates every running agent (the worker is shutting down). */
  stopAll: () => void;
}

/** Largest output batch per POST, in UTF-16 code units; well under the server's body limit. */
const MAX_BATCH_CHARS = 256 * 1024;
const POST_ATTEMPTS = 3;
/**
 * The exit report is the only thing that ends the run on the server, so it
 * keeps trying through a longer outage (about a minute) than output does.
 */
const EXIT_POST_ATTEMPTS = 12;
const POST_RETRY_DELAY_MS = 250;

interface ActiveRun {
  runId: string;
  child: ChildProcess | null;
  cwd: string;
  outbox: WorkerRunOutputChunk[];
  /** Every POST for this run, in order. */
  chain: Promise<void>;
  finished: boolean;
}

function takeBatch(outbox: WorkerRunOutputChunk[]): WorkerRunOutputChunk[] {
  const batch: WorkerRunOutputChunk[] = [];
  let size = 0;
  while (outbox.length > 0 && (batch.length === 0 || size + outbox[0]!.data.length <= MAX_BATCH_CHARS)) {
    const chunk = outbox.shift()!;
    size += chunk.data.length;
    batch.push(chunk);
  }
  return batch;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // Agents run as process-group leaders on POSIX so their tools die with them.
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

export function createWorkerRunExecutor(options: WorkerRunExecutorOptions): WorkerRunExecutor {
  const base = options.serverUrl.replace(/\/+$/, '');
  const runs = new Map<string, ActiveRun>();

  /**
   * POSTs to the server. False only when the server says it no longer knows
   * this run (404/401), which stops the agent. A network failure that outlasts
   * the retries returns true: that batch is lost, but the run keeps going and
   * the server still decides its end.
   */
  const post = async (pathname: string, body: unknown, attempts = POST_ATTEMPTS): Promise<boolean> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(`${base}${pathname}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.ok) return true;
        if (response.status === 404 || response.status === 401) return false;
      } catch {
        // Network blip; retried below.
      }
      if (attempt >= attempts) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POST_RETRY_DELAY_MS * attempt, 10_000)));
    }
  };

  const enqueue = (run: ActiveRun, task: () => Promise<void>) => {
    run.chain = run.chain.then(task, task);
  };

  const sendOutput = (run: ActiveRun, chunk: WorkerRunOutputChunk) => {
    run.outbox.push(chunk);
    enqueue(run, async () => {
      while (run.outbox.length > 0) {
        const request: WorkerRunOutputRequest = { chunks: takeBatch(run.outbox) };
        if (!(await post(workerBridgeRunOutputPath(run.runId), request))) {
          // The server dropped the run; nobody is listening for this agent any more.
          run.outbox.length = 0;
          if (run.child) signalTree(run.child, 'SIGTERM');
          return;
        }
      }
    });
  };

  const finish = (run: ActiveRun, result: WorkerRunExitRequest) => {
    if (run.finished) return;
    run.finished = true;
    enqueue(run, async () => {
      await post(workerBridgeRunExitPath(run.runId), result, EXIT_POST_ATTEMPTS);
      runs.delete(run.runId);
      fs.rm(run.cwd, { recursive: true, force: true }, () => {});
      options.onEvent?.({ type: 'finished', runId: run.runId, result });
    });
  };

  const start = (request: WorkerRunStartEvent) => {
    if (typeof request?.runId !== 'string' || runs.has(request.runId)) return;
    const run: ActiveRun = {
      runId: request.runId,
      child: null,
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'od-worker-run-')),
      outbox: [],
      chain: Promise.resolve(),
      finished: false,
    };
    runs.set(run.runId, run);
    options.onEvent?.({ type: 'started', runId: run.runId, agentId: request.agentId });

    const launch = options.resolveLaunch(request.agentId, Array.isArray(request.args) ? request.args : []);
    if (!launch) {
      finish(run, {
        code: null,
        signal: null,
        error: `Agent "${request.agentId}" is not installed or not on PATH on the worker PC (${os.hostname()}).`,
      });
      return;
    }
    const stdinMode = request.stdin === 'ignore' ? 'ignore' : 'pipe';
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: run.cwd,
        env: options.env ?? process.env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (error) {
      finish(run, { code: null, signal: null, error: `could not start ${request.agentId}: ${(error as Error).message}` });
      return;
    }
    run.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => sendOutput(run, { stream: 'stdout', data }));
    child.stderr?.on('data', (data: string) => sendOutput(run, { stream: 'stderr', data }));
    // A fast-exiting agent closes its stdin early; its exit says why.
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      finish(run, { code: null, signal: null, error: `could not start ${request.agentId}: ${error.message}` });
    });
    child.on('close', (code, signal) => finish(run, { code, signal }));
    if (typeof request.stdin === 'object' && request.stdin && typeof request.stdin.prompt === 'string') {
      child.stdin?.end(request.stdin.prompt);
    }
  };

  const handle = (event: string, data: unknown) => {
    if (event === WORKER_RUN_EVENTS.start) {
      start(data as WorkerRunStartEvent);
      return;
    }
    const run = runs.get((data as { runId?: string } | null)?.runId ?? '');
    const child = run?.child;
    if (!child) return;
    if (event === WORKER_RUN_EVENTS.stdin) {
      const { data: text } = data as WorkerRunStdinEvent;
      if (typeof text === 'string' && child.stdin?.writable) child.stdin.write(text);
    } else if (event === WORKER_RUN_EVENTS.stdinEnd) {
      child.stdin?.end();
    } else if (event === WORKER_RUN_EVENTS.kill) {
      const { signal } = data as WorkerRunKillEvent;
      signalTree(child, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    }
  };

  return {
    handle,
    stopAll() {
      for (const run of runs.values()) {
        if (run.child) signalTree(run.child, 'SIGTERM');
      }
    },
  };
}
