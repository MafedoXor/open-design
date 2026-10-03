import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerStatus, WorkerTokenCreateResponse } from '@open-design/contracts';
import { runWorker } from '../src/workers/worker-client.js';
import { createWorkerRunExecutor, type WorkerRunExecutor } from '../src/workers/worker-runs.js';
import type { RemoteAgentProcess } from '../src/workers/remote-runs.js';
import { startWorkerTestServer, type WorkerTestServer } from './helpers/worker-server.js';

/**
 * A run handed to a worker goes over the real bridge: the server writes
 * `run-start` on the worker's channel, the worker spawns the agent on its PC
 * and posts the output and exit back. The "agent" here is a node one-liner,
 * so nothing depends on an installed CLI.
 */

let server: WorkerTestServer;
const controllers: AbortController[] = [];
const executors: WorkerRunExecutor[] = [];

beforeEach(async () => {
  server = await startWorkerTestServer();
});

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.stopAll();
  for (const controller of controllers.splice(0)) controller.abort();
  await server.close();
});

async function issueToken(person: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/workers/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person }),
  });
  return ((await response.json()) as WorkerTokenCreateResponse).token;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Connects a worker for `person` whose agents are all `node`. Records which runs it started. */
async function connectWorker(person: string, { installed = true } = {}) {
  const token = await issueToken(person);
  const started: string[] = [];
  const executor = createWorkerRunExecutor({
    serverUrl: server.baseUrl,
    token,
    resolveLaunch: (_agentId, args) => (installed ? { command: process.execPath, args } : null),
    onEvent: (event) => {
      if (event.type === 'started') started.push(event.runId);
    },
  });
  executors.push(executor);
  const controller = new AbortController();
  controllers.push(controller);
  void runWorker({
    serverUrl: server.baseUrl,
    token,
    describe: async () => ({ hostname: `${person}-pc`, platform: process.platform, agents: [] }),
    signal: controller.signal,
    reconnectDelayMs: () => 10,
    onServerEvent: executor.handle,
  });
  await eventually(
    async () => (await (await fetch(`${server.baseUrl}/api/workers/${person}`)).json()) as WorkerStatus,
    (status) => status.online,
  );
  return { started };
}

function collect(child: RemoteAgentProcess) {
  let stdout = '';
  let stderr = '';
  const chunks: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.on('close', (code: number | null) => resolve(code)));
  return { closed, get stdout() { return stdout; }, get stderr() { return stderr; }, chunks };
}

const ECHO_PROMPT = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'echo', prompt: input, cwd: process.cwd() }));
  console.error('done');
});
`;

describe('runs over the worker bridge', () => {
  it('runs the agent on the person\'s worker and streams its output back', async () => {
    await connectWorker('Alice');
    const child = server.runs.spawn('Alice', {
      runId: 'run-1',
      agentId: 'claude',
      args: ['-e', ECHO_PROMPT],
      stdin: { prompt: 'make a poster' },
    });
    const out = collect(child);
    expect(await out.closed).toBe(0);
    const line = JSON.parse(out.stdout.trim()) as { prompt: string; cwd: string };
    expect(line.prompt).toBe('make a poster');
    expect(out.stderr).toBe('done\n');
  });

  it('delivers output while the agent is still running, not only at exit', async () => {
    await connectWorker('Alice');
    const child = server.runs.spawn('Alice', {
      runId: 'run-live',
      agentId: 'claude',
      args: ['-e', "console.log('first'); setTimeout(() => console.log('second'), 400);"],
      stdin: 'ignore',
    });
    const out = collect(child);
    await eventually(async () => out.stdout, (text) => text.includes('first'));
    expect(child.exitCode).toBeNull();
    expect(await out.closed).toBe(0);
    expect(out.stdout).toBe('first\nsecond\n');
  });

  it('hands the run to that person\'s worker and no other', async () => {
    const alice = await connectWorker('Alice');
    const bob = await connectWorker('Bob');
    const out = collect(server.runs.spawn('Bob', {
      runId: 'run-bob',
      agentId: 'claude',
      args: ['-e', 'process.exit(0)'],
      stdin: 'ignore',
    }));
    expect(await out.closed).toBe(0);
    expect(bob.started).toEqual(['run-bob']);
    expect(alice.started).toEqual([]);
  });

  it('reports a failing agent\'s exit code', async () => {
    await connectWorker('Alice');
    const out = collect(server.runs.spawn('Alice', {
      runId: 'run-fail',
      agentId: 'claude',
      args: ['-e', "console.error('boom'); process.exit(4)"],
      stdin: 'ignore',
    }));
    expect(await out.closed).toBe(4);
    expect(out.stderr).toBe('boom\n');
  });

  it('fails the run when the agent is not installed on the worker\'s PC', async () => {
    await connectWorker('Alice', { installed: false });
    const out = collect(server.runs.spawn('Alice', {
      runId: 'run-missing',
      agentId: 'claude',
      args: [],
      stdin: 'ignore',
    }));
    expect(await out.closed).not.toBe(0);
    expect(out.stderr).toContain('claude');
  });

  it('pipes stdin written by the server to the agent', async () => {
    await connectWorker('Alice');
    const child = server.runs.spawn('Alice', {
      runId: 'run-pipe',
      agentId: 'claude',
      args: ['-e', ECHO_PROMPT],
      stdin: 'pipe',
    });
    const out = collect(child);
    child.stdin!.write('{"type":"user"}\n');
    child.stdin!.end();
    expect(await out.closed).toBe(0);
    expect((JSON.parse(out.stdout.trim()) as { prompt: string }).prompt).toBe('{"type":"user"}\n');
  });
});
