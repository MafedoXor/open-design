import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerTokenCreateResponse } from '@open-design/contracts';
import { runWorker } from '../src/workers/worker-client.js';
import { createWorkerRunExecutor, type WorkerRunExecutor } from '../src/workers/worker-runs.js';
import type { RemoteAgentProcess } from '../src/workers/remote-runs.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import { startWorkerTestServer, waitForWorkerOnline, type WorkerTestServer } from './helpers/worker-server.js';

/**
 * Stopping a run that executes on a worker: the server's kill reaches the
 * agent's whole process tree on the PC, a run the server has ended stops
 * counting at once, and a worker that comes back after the server ended its
 * run stops it instead of resuming it. The "agents" are node one-liners.
 */

let server: WorkerTestServer;
let scratch: string;
let projectDir: string;
let workRoot: string;
const controllers: AbortController[] = [];
const executors: WorkerRunExecutor[] = [];

beforeEach(async () => {
  server = await startWorkerTestServer();
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-worker-cancel-')));
  projectDir = path.join(scratch, 'server', 'p1');
  workRoot = path.join(scratch, 'pc');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'index.html'), 'before');
});

afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.stopAll();
  for (const controller of controllers.splice(0)) controller.abort();
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function issueToken(person: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/workers/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person }),
  });
  return ((await response.json()) as WorkerTokenCreateResponse).token;
}

/** Holds `executor`'s channel to the server open until the returned controller aborts. */
function connect(token: string, executor: WorkerRunExecutor): AbortController {
  const controller = new AbortController();
  controllers.push(controller);
  void runWorker({
    serverUrl: server.baseUrl,
    token,
    describe: async () => ({ hostname: 'pc', platform: process.platform, agents: [] }),
    signal: controller.signal,
    reconnectDelayMs: () => 10,
    onServerEvent: executor.handle,
  });
  return controller;
}

async function connectWorker(person: string) {
  const token = await issueToken(person);
  const executor = createWorkerRunExecutor({
    serverUrl: server.baseUrl,
    token,
    workRoot,
    killGraceMs: 200,
    resolveLaunch: (_agentId, args) => ({ command: process.execPath, args }),
  });
  executors.push(executor);
  const controller = connect(token, executor);
  await waitForWorkerOnline(server, person);
  return { token, executor, controller };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watch(child: RemoteAgentProcess) {
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.resume();
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('close', (code: number | null, signal: string | null) => resolve({ code, signal })));
  return { closed, get stdout() { return stdout; } };
}

/**
 * Starts a grandchild that outlives a plain kill of its parent, writes a file
 * into the project, and prints both pids. With `ignoreTerm` it also ignores
 * SIGTERM, so only SIGKILL ends it.
 */
function treeAgent({ ignoreTerm = false } = {}): string {
  return `
    const { spawn } = require('child_process');
    const fs = require('fs');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    fs.writeFileSync('late.html', 'agent');
    console.log(JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
  `;
}

function startRun(runId: string, script: string): RemoteAgentProcess {
  return server.runs.spawn('Alice', {
    runId,
    agentId: 'claude',
    args: ['-e', script],
    stdin: 'ignore',
    project: { id: 'p1', dir: projectDir },
  });
}

async function pidsOf(out: ReturnType<typeof watch>): Promise<{ agent: number; grandchild: number }> {
  await until(() => out.stdout.includes('grandchild'), 'the agent to start');
  return JSON.parse(out.stdout.trim()) as { agent: number; grandchild: number };
}

describe.skipIf(process.platform === 'win32')('stopping a run on a worker', () => {
  it('kills the agent and the processes it started, and removes the copy', async () => {
    await connectWorker('Alice');
    const child = startRun('run-stop', treeAgent());
    const out = watch(child);
    const { agent, grandchild } = await pidsOf(out);
    // What the server's cancel does to a run's process: SIGTERM, SIGKILL after its grace.
    child.kill('SIGTERM');
    const ended = await out.closed;
    expect(ended.code).toBeNull();
    expect(ended.signal).toBe('SIGTERM');
    await until(() => !isAlive(agent) && !isAlive(grandchild), 'the agent tree to die');
    expect(readdirSync(workRoot)).toEqual([]);
    // The agent's work up to the stop is kept, as it would be on the server.
    expect(readFileSync(path.join(projectDir, 'late.html'), 'utf8')).toBe('agent');
  });

  it('ends in the cancelled state when the run is stopped, which frees the project', async () => {
    await connectWorker('Alice');
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
    });
    const run = runs.create({ projectId: 'p1', conversationId: 'c1' });
    const child = startRun(run.id, treeAgent());
    // The handle the chat-run launcher stores for a worker run.
    (run as { child: unknown }).child = child;
    // As the server wires every worker run: once terminal, the worker's copy stops counting.
    void runs.wait(run).then(() => server.runs.release(run.id));
    const out = watch(child);
    const { agent, grandchild } = await pidsOf(out);

    // What Stop in the UI and `od run cancel` both call.
    await runs.cancel(run, 'user_stop');

    expect(run.status).toBe('canceled');
    expect(runs.list({ projectId: 'p1', status: 'active' })).toEqual([]);
    await until(() => !isAlive(agent) && !isAlive(grandchild), 'the agent tree to die');
    await until(() => server.runs.liveRunIds('Alice').length === 0, 'the worker run to be released');
    await until(() => readdirSync(workRoot).length === 0, 'the copy to be removed');
  });

  it('kills an agent that ignores SIGTERM once its grace period is over', async () => {
    await connectWorker('Alice');
    const child = startRun('run-stubborn', treeAgent({ ignoreTerm: true }));
    const out = watch(child);
    const { agent, grandchild } = await pidsOf(out);
    child.kill('SIGTERM');
    const ended = await out.closed;
    expect(ended.signal).toBe('SIGKILL');
    await until(() => !isAlive(agent) && !isAlive(grandchild), 'the agent tree to die');
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it('ends a run the server released at once, and applies nothing the worker sends after', async () => {
    await connectWorker('Alice');
    const child = startRun('run-released', treeAgent({ ignoreTerm: true }));
    const out = watch(child);
    const { agent, grandchild } = await pidsOf(out);
    server.runs.release('run-released');
    const ended = await out.closed;
    expect(ended).toEqual({ code: null, signal: 'SIGKILL' });
    expect(server.runs.liveRunIds('Alice')).toEqual([]);
    await until(() => !isAlive(agent) && !isAlive(grandchild), 'the agent tree to die');
    await until(() => readdirSync(workRoot).length === 0, 'the copy to be removed');
    expect(existsSync(path.join(projectDir, 'late.html'))).toBe(false);
  });

  it('fails the run when its worker goes away, and the worker stops it on reconnect instead of resuming it', async () => {
    const { token, executor, controller } = await connectWorker('Alice');
    const child = startRun('run-orphaned', treeAgent());
    const out = watch(child);
    const { agent, grandchild } = await pidsOf(out);
    // The PC drops off; the server notices the closed channel and ends the run.
    controller.abort();
    const ended = await out.closed;
    expect(ended.code).not.toBe(0);
    expect(isAlive(agent)).toBe(true);
    // The same worker comes back with the agent still running.
    connect(token, executor);
    await until(() => !isAlive(agent) && !isAlive(grandchild), 'the orphaned agent to be stopped');
    await until(() => readdirSync(workRoot).length === 0, 'the copy to be removed');
    expect(existsSync(path.join(projectDir, 'late.html'))).toBe(false);
    expect(server.runs.liveRunIds('Alice')).toEqual([]);
  });
});
