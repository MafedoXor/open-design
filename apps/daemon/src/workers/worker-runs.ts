import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  WORKER_RUN_ENV_KEYS,
  WORKER_RUN_EVENTS,
  workerBridgeRunExitPath,
  workerBridgeRunOutputPath,
  workerBridgeRunProjectPath,
  type WorkerRunExitRequest,
  type WorkerRunKillEvent,
  type WorkerRunOutputChunk,
  type WorkerRunOutputRequest,
  type WorkerRunProject,
  type WorkerRunStartEvent,
  type WorkerRunStdinEvent,
} from '@open-design/contracts';
import {
  collectProjectChanges,
  packProjectChanges,
  snapshotProject,
  unpackProject,
  type ProjectSnapshot,
} from './project-transfer.js';

/**
 * The worker's side of a run: `od worker` received `run-start` on its
 * channel, copies the run's project to this PC, starts the agent CLI in that
 * copy, posts its output back, and when the agent ends sends back the files
 * it created, changed or deleted.
 *
 * Invariants:
 * - Output reaches the server in the order the agent wrote it. The file
 *   changes are sent after the last output, and the exit report only after
 *   both, so the server has the project's new state before the run ends.
 * - Each run gets its own directory under the work root, removed when the run
 *   ends however it ends. A project run reuses the same path every time for
 *   that project (unless another run of it is live), so an agent CLI that
 *   keys its sessions by working directory can resume them on the next turn.
 * - The agent runs with this PC's own environment and login. From the server
 *   it takes only the run's callback variables (`WORKER_RUN_ENV_KEYS`), and
 *   reaches the server at the URL this worker uses.
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
  /** This PC's environment for agents. Defaults to the worker's own. */
  env?: NodeJS.ProcessEnv;
  /** Where runs get their working directories. Defaults to `od-worker` in the OS temp directory. */
  workRoot?: string;
  /** How an agent on this PC runs `od` (`OD_BIN`) and with which Node (`OD_NODE_BIN`). */
  cliEnv?: { OD_BIN?: string; OD_NODE_BIN?: string };
  onEvent?: (event: WorkerRunExecutorEvent) => void;
}

export interface WorkerRunExecutor {
  /** Feed every server event from the worker channel here. */
  handle: (event: string, data: unknown) => void;
  /**
   * Terminates every running agent (the worker is shutting down). Resolves
   * once each run has sent its changes and exit and removed its copy.
   */
  stopAll: () => Promise<void>;
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
  /**
   * Holds the agent's working directory (`project/`) and nothing the agent
   * needs. `null` until created, unless the project's usual one was claimed.
   */
  root: string | null;
  cwd: string;
  project: WorkerRunProject | null;
  /** The copied project as the agent found it; `null` until the copy is complete. */
  snapshot: ProjectSnapshot | null;
  outbox: WorkerRunOutputChunk[];
  /** Every POST for this run, in order. */
  chain: Promise<void>;
  finished: boolean;
  /** Set when the server stopped knowing this run; nothing more is sent for it. */
  gone: boolean;
  /** stdin and kill that arrived before the agent was started. */
  pendingStdin: string[];
  pendingStdinEnd: boolean;
  pendingKill: NodeJS.Signals | null;
  /** Cancels the project download when the run is killed before its agent starts. */
  abort: AbortController;
  /** Settles when the run has been reported and its directory removed. */
  done: Promise<void>;
  markDone: () => void;
}

/** Same server and project → same directory name, so session-keyed agents can resume. */
function projectRunDirName(serverUrl: string, projectId: string): string {
  return `project-${createHash('sha256').update(`${serverUrl}\0${projectId}`).digest('hex').slice(0, 16)}`;
}

/**
 * Replaces the server's project path with the worker's copy wherever it
 * appears as a whole path or a path prefix inside `value`.
 */
export function remapProjectPath(value: string, serverDir: string, localDir: string): string {
  if (!serverDir) return value;
  let out = '';
  let from = 0;
  for (;;) {
    const at = value.indexOf(serverDir, from);
    if (at < 0) return out + value.slice(from);
    const next = value[at + serverDir.length];
    const wholePath = next === undefined || next === '/' || next === '\\' || !/[\w.-]/.test(next);
    out += value.slice(from, at) + (wholePath ? localDir : serverDir);
    from = at + serverDir.length;
  }
}

/** `text` with the server's project path moved to this PC's copy (argv, env, prompt). */
function toPcPaths(run: ActiveRun, text: string): string {
  return run.project ? remapProjectPath(text, run.project.dir, run.cwd) : text;
}

/** The callback variables the server sent, with its project path moved to this PC's copy. */
function serverRunEnv(request: WorkerRunStartEvent, run: ActiveRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const sent = (request.env ?? {}) as Record<string, unknown>;
  for (const key of WORKER_RUN_ENV_KEYS) {
    const value = sent[key];
    if (typeof value !== 'string') continue;
    env[key] = toPcPaths(run, value);
  }
  return env;
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
   * POSTs `body` to the server, retrying network failures and server errors
   * up to `attempts` times. `gone` when the server no longer knows this run
   * (404/401); otherwise why it was not accepted, or `null` when it was.
   */
  const send = async (
    pathname: string,
    body: string | Uint8Array,
    contentType: string,
    attempts: number,
  ): Promise<null | 'gone' | { problem: string }> => {
    let problem = 'the server could not be reached';
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(`${base}${pathname}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': contentType },
          body,
        });
        if (response.ok) return null;
        if (response.status === 404 || response.status === 401) return 'gone';
        problem = `${response.status} ${await response.text().catch(() => '')}`.trim();
        // The server read the request and refused it; sending it again cannot help.
        if (response.status < 500) return { problem };
      } catch (error) {
        problem = (error as Error).message;
      }
      if (attempt >= attempts) return { problem };
      await new Promise((resolve) => setTimeout(resolve, Math.min(POST_RETRY_DELAY_MS * attempt, 10_000)));
    }
  };

  /**
   * POSTs JSON. False only when the server says it no longer knows this run,
   * which stops the agent. Any other failure returns true: that batch is lost,
   * but the run keeps going and the server still decides its end.
   */
  const post = async (pathname: string, body: unknown, attempts = POST_ATTEMPTS): Promise<boolean> =>
    (await send(pathname, JSON.stringify(body), 'application/json', attempts)) !== 'gone';

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
          run.gone = true;
          run.outbox.length = 0;
          if (run.child) signalTree(run.child, 'SIGTERM');
          return;
        }
      }
    });
  };

  /**
   * Sends the agent's file changes. Resolves with why they could not be
   * sent, or `null` when they were (or there was nothing to send).
   */
  const sendChanges = async (run: ActiveRun): Promise<string | null> => {
    if (!run.snapshot || !run.root || run.gone) return null;
    let body: Buffer;
    try {
      const changes = await collectProjectChanges(run.cwd, run.snapshot);
      if (changes.written.length === 0 && changes.deleted.length === 0) return null;
      body = await packProjectChanges(run.root, changes);
    } catch (error) {
      return `could not read the agent's changes: ${(error as Error).message}`;
    }
    const outcome = await send(workerBridgeRunProjectPath(run.runId), new Uint8Array(body), 'application/gzip', EXIT_POST_ATTEMPTS);
    // A run the server dropped has nobody to apply its changes for.
    return outcome && outcome !== 'gone' ? outcome.problem : null;
  };

  const finish = (run: ActiveRun, result: WorkerRunExitRequest) => {
    if (run.finished) return;
    run.finished = true;
    enqueue(run, async () => {
      let report = result;
      const problem = await sendChanges(run);
      if (problem) {
        report = {
          code: null,
          signal: null,
          error: `The agent finished, but its file changes could not be sent to the server: ${problem}`,
        };
      }
      // The copy is not needed past this point; remove it before the server
      // hears the run ended, so nothing of it outlives the run.
      if (run.root) await fs.promises.rm(run.root, { recursive: true, force: true }).catch(() => {});
      await post(workerBridgeRunExitPath(run.runId), report, EXIT_POST_ATTEMPTS);
      runs.delete(run.runId);
      options.onEvent?.({ type: 'finished', runId: run.runId, result: report });
      run.markDone();
    });
  };

  const workRoot = options.workRoot ?? path.join(os.tmpdir(), 'od-worker');

  /**
   * The project's usual run directory, or `null` when there is none or a live
   * run holds it. Claimed synchronously so two runs cannot both take it.
   */
  const claimUsualRoot = (project: WorkerRunProject | null): string | null => {
    if (!project) return null;
    const root = path.join(workRoot, projectRunDirName(base, project.id));
    return [...runs.values()].some((run) => run.root === root) ? null : root;
  };

  /** Empties the run's claimed directory, or creates a unique one when it has none. */
  const createRunRoot = async (run: ActiveRun): Promise<void> => {
    await fs.promises.mkdir(workRoot, { recursive: true });
    if (run.root) {
      // Left over from a worker that stopped mid-run.
      await fs.promises.rm(run.root, { recursive: true, force: true });
    } else {
      run.root = await fs.promises.mkdtemp(path.join(workRoot, 'run-'));
    }
    run.cwd = path.join(run.root, 'project');
    await fs.promises.mkdir(run.cwd, { recursive: true });
  };

  /** Copies the run's project into its working directory. Resolves with why it could not, or `null`. */
  const copyProject = async (run: ActiveRun): Promise<string | null> => {
    try {
      const response = await fetch(`${base}${workerBridgeRunProjectPath(run.runId)}`, {
        headers: { authorization: `Bearer ${options.token}` },
        signal: run.abort.signal,
      });
      if (response.status === 404 || response.status === 401) {
        run.gone = true;
        return 'the server no longer has this run';
      }
      if (!response.ok || !response.body) {
        return `${response.status} ${await response.text().catch(() => '')}`.trim();
      }
      await unpackProject(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream, { signal: run.abort.signal }), run.cwd);
      run.snapshot = await snapshotProject(run.cwd);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  const launch = (run: ActiveRun, request: WorkerRunStartEvent) => {
    const args = (Array.isArray(request.args) ? request.args : []).map((arg) =>
      typeof arg === 'string' ? toPcPaths(run, arg) : arg);
    const resolved = options.resolveLaunch(request.agentId, args);
    if (!resolved) {
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
      child = spawn(resolved.command, resolved.args, {
        cwd: run.cwd,
        env: {
          ...(options.env ?? process.env),
          ...serverRunEnv(request, run),
          OD_DAEMON_URL: base,
          ...options.cliEnv,
        },
        stdio: [stdinMode, 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
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
      child.stdin?.end(toPcPaths(run, request.stdin.prompt));
      return;
    }
    for (const text of run.pendingStdin.splice(0)) child.stdin?.write(toPcPaths(run, text));
    if (run.pendingStdinEnd) child.stdin?.end();
  };

  const prepareAndLaunch = async (run: ActiveRun, request: WorkerRunStartEvent) => {
    try {
      await createRunRoot(run);
    } catch (error) {
      finish(run, { code: null, signal: null, error: `could not create a working directory: ${(error as Error).message}` });
      return;
    }
    const problem = run.project ? await copyProject(run) : null;
    // A run killed while its project was copying ends as killed, not as a failed copy.
    if (run.pendingKill) {
      finish(run, { code: null, signal: run.pendingKill });
      return;
    }
    if (problem) {
      finish(run, { code: null, signal: null, error: `could not copy the project to this PC: ${problem}` });
      return;
    }
    launch(run, request);
  };

  const start = (request: WorkerRunStartEvent) => {
    if (typeof request?.runId !== 'string' || runs.has(request.runId)) return;
    const project = request.project && typeof request.project.id === 'string' && typeof request.project.dir === 'string'
      ? { id: request.project.id, dir: request.project.dir }
      : null;
    const run: ActiveRun = {
      runId: request.runId,
      child: null,
      root: claimUsualRoot(project),
      cwd: '',
      project,
      snapshot: null,
      outbox: [],
      chain: Promise.resolve(),
      finished: false,
      gone: false,
      pendingStdin: [],
      pendingStdinEnd: false,
      pendingKill: null,
      abort: new AbortController(),
      done: Promise.resolve(),
      markDone: () => {},
    };
    run.done = new Promise<void>((resolve) => {
      run.markDone = resolve;
    });
    runs.set(run.runId, run);
    options.onEvent?.({ type: 'started', runId: run.runId, agentId: request.agentId });
    void prepareAndLaunch(run, request);
  };

  const handle = (event: string, data: unknown) => {
    if (event === WORKER_RUN_EVENTS.start) {
      start(data as WorkerRunStartEvent);
      return;
    }
    const run = runs.get((data as { runId?: string } | null)?.runId ?? '');
    if (!run || run.finished) return;
    const child = run.child;
    // Until the agent is started (its project is still being copied), stdin
    // and kill wait for it.
    if (event === WORKER_RUN_EVENTS.stdin) {
      const { data: text } = data as WorkerRunStdinEvent;
      if (typeof text !== 'string') return;
      if (!child) run.pendingStdin.push(text);
      else if (child.stdin?.writable) child.stdin.write(toPcPaths(run, text));
    } else if (event === WORKER_RUN_EVENTS.stdinEnd) {
      if (!child) run.pendingStdinEnd = true;
      else child.stdin?.end();
    } else if (event === WORKER_RUN_EVENTS.kill) {
      const { signal } = data as WorkerRunKillEvent;
      const resolved: NodeJS.Signals = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
      if (child) {
        signalTree(child, resolved);
      } else {
        run.pendingKill = resolved;
        run.abort.abort();
      }
    }
  };

  return {
    handle,
    async stopAll() {
      const live = [...runs.values()];
      for (const run of live) {
        if (run.child) {
          signalTree(run.child, 'SIGTERM');
        } else {
          run.pendingKill = 'SIGTERM';
          run.abort.abort();
        }
      }
      await Promise.all(live.map((run) => run.done));
    },
  };
}
