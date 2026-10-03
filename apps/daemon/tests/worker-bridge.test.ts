import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerStatus, WorkerTokenCreateResponse } from '@open-design/contracts';
import {
  runWorker,
  WorkerTokenRejectedError,
  type WorkerClientEvent,
} from '../src/workers/worker-client.js';
import { startWorkerTestServer, type WorkerTestServer } from './helpers/worker-server.js';

const describeWorker = async () => ({
  hostname: 'alice-pc',
  platform: 'darwin',
  agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.0' }],
});

let server: WorkerTestServer;
let baseUrl: string;
const controllers: AbortController[] = [];

async function startServer(offlineAfterMs?: number): Promise<void> {
  server = await startWorkerTestServer({ offlineAfterMs });
  baseUrl = server.baseUrl;
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await server.close();
});

async function issueToken(person: string): Promise<WorkerTokenCreateResponse> {
  const response = await fetch(`${baseUrl}/api/workers/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as WorkerTokenCreateResponse;
}

async function workerStatus(person: string): Promise<WorkerStatus> {
  const response = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(person)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkerStatus;
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

function startWorker(token: string) {
  const controller = new AbortController();
  controllers.push(controller);
  const events: WorkerClientEvent[] = [];
  const done = runWorker({
    serverUrl: baseUrl,
    token,
    describe: describeWorker,
    signal: controller.signal,
    reconnectDelayMs: () => 10,
    onEvent: (event) => events.push(event),
  });
  return { controller, events, done };
}

describe('worker bridge', () => {
  it('a worker with a valid token shows online with the agents on its PC', async () => {
    const { token } = await issueToken('Alice');
    startWorker(token);
    const status = await eventually(() => workerStatus('Alice'), (s) => s.online);
    expect(status).toMatchObject({
      person: 'Alice',
      hasToken: true,
      online: true,
      hostname: 'alice-pc',
      agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.0' }],
    });
  });

  it('lists every person with a token, online or not', async () => {
    const alice = await issueToken('Alice');
    await issueToken('Bob');
    startWorker(alice.token);
    await eventually(() => workerStatus('Alice'), (s) => s.online);
    const response = await fetch(`${baseUrl}/api/workers`);
    const body = (await response.json()) as { workers: WorkerStatus[] };
    expect(body.workers.map((w) => [w.person, w.online])).toEqual([
      ['Alice', true],
      ['Bob', false],
    ]);
  });

  it('refuses a worker with a wrong token, without retrying', async () => {
    await issueToken('Alice');
    const { done } = startWorker('odw_wrong');
    await expect(done).rejects.toBeInstanceOf(WorkerTokenRejectedError);
    expect((await workerStatus('Alice')).online).toBe(false);
  });

  it('revoking the token disconnects the worker and refuses it from then on', async () => {
    const { token } = await issueToken('Alice');
    const { done } = startWorker(token);
    await eventually(() => workerStatus('Alice'), (s) => s.online);
    const revoke = await fetch(`${baseUrl}/api/workers/tokens/Alice`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);
    await expect(done).rejects.toBeInstanceOf(WorkerTokenRejectedError);
    expect(await workerStatus('Alice')).toMatchObject({ online: false, hasToken: false });
  });

  it('rotating the token disconnects a worker still holding the old one', async () => {
    const first = await issueToken('Alice');
    const { done } = startWorker(first.token);
    await eventually(() => workerStatus('Alice'), (s) => s.online);
    const second = await issueToken('Alice');
    expect(second.rotated).toBe(true);
    await expect(done).rejects.toBeInstanceOf(WorkerTokenRejectedError);
  });

  it('a failure inspecting the PC is retried, not fatal', async () => {
    const { token } = await issueToken('Alice');
    const controller = new AbortController();
    controllers.push(controller);
    let calls = 0;
    const done = runWorker({
      serverUrl: baseUrl,
      token,
      describe: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe crashed');
        return describeWorker();
      },
      signal: controller.signal,
      reconnectDelayMs: () => 10,
    });
    await eventually(() => workerStatus('Alice'), (s) => s.online);
    controller.abort();
    await done;
  });

  it('a worker that stops shows offline', async () => {
    const { token } = await issueToken('Alice');
    const { controller, done } = startWorker(token);
    await eventually(() => workerStatus('Alice'), (s) => s.online);
    controller.abort();
    await done;
    await eventually(() => workerStatus('Alice'), (s) => !s.online);
  });

  it('a worker that stops heartbeating shows offline within the bound', async () => {
    await server.close();
    await startServer(150);
    const { token } = await issueToken('Alice');
    // A half-open connection: the stream stays open but nothing heartbeats.
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${baseUrl}/api/worker-bridge/connect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(await describeWorker()),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect((await workerStatus('Alice')).online).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await workerStatus('Alice')).online).toBe(false);
  });

  it('rejects an invalid person name', async () => {
    const response = await fetch(`${baseUrl}/api/workers/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person: '../etc' }),
    });
    expect(response.status).toBe(400);
  });
});
