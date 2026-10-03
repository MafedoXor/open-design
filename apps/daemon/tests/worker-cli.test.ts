import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerStatus, WorkerTokenCreateResponse } from '@open-design/contracts';
import { runWorkerCli, type WorkerCliDeps } from '../src/workers/worker-cli.js';
import { startWorkerTestServer, type WorkerTestServer } from './helpers/worker-server.js';

let server: WorkerTestServer;

beforeEach(async () => {
  server = await startWorkerTestServer();
});

afterEach(async () => {
  await server.close();
});

function cli(overrides: Partial<WorkerCliDeps> = {}) {
  const out: string[] = [];
  const errOut: string[] = [];
  const deps: WorkerCliDeps = {
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => errOut.push(text),
    describe: async () => ({
      hostname: 'alice-pc',
      platform: 'linux',
      agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.0' }],
    }),
    ...overrides,
  };
  return {
    run: (args: string[]) => runWorkerCli(args, deps),
    out: () => out.join(''),
    err: () => errOut.join(''),
  };
}

const daemon = () => ['--daemon-url', server.baseUrl];

async function createToken(person: string): Promise<WorkerTokenCreateResponse> {
  const c = cli();
  expect(await c.run(['token', 'create', '--person', person, '--json', ...daemon()])).toBe(0);
  return JSON.parse(c.out()) as WorkerTokenCreateResponse;
}

describe('od worker', () => {
  it('token create --json returns the new token once', async () => {
    const created = await createToken('Alice');
    expect(created).toMatchObject({ person: 'Alice', rotated: false });
    expect(created.token).toMatch(/^odw_/);
  });

  it('status --json reports the same state the UI reads', async () => {
    await createToken('Alice');
    const c = cli();
    expect(await c.run(['status', '--person', 'Alice', '--json', ...daemon()])).toBe(0);
    const status = JSON.parse(c.out()) as WorkerStatus;
    const direct = await (await fetch(`${server.baseUrl}/api/workers/Alice`)).json();
    expect(status).toEqual(direct);
    expect(status).toMatchObject({ person: 'Alice', hasToken: true, online: false });
  });

  it('status without --person lists every worker', async () => {
    await createToken('Alice');
    const c = cli();
    expect(await c.run(['status', '--json', ...daemon()])).toBe(0);
    expect((JSON.parse(c.out()) as { workers: WorkerStatus[] }).workers.map((w) => w.person)).toEqual(['Alice']);
  });

  it('a connected worker shows online in status, with its agents', async () => {
    const { token } = await createToken('Alice');
    const controller = new AbortController();
    const worker = cli({ signal: controller.signal });
    const running = worker.run(['--server', server.baseUrl, '--token', token]);
    const deadline = Date.now() + 3_000;
    let status: WorkerStatus;
    do {
      const c = cli();
      await c.run(['status', '--person', 'Alice', '--json', ...daemon()]);
      status = JSON.parse(c.out()) as WorkerStatus;
      if (status.online) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    expect(status).toMatchObject({ online: true, agents: [{ id: 'claude' }] });
    controller.abort();
    expect(await running).toBe(0);
    expect(worker.err()).toContain('connected');
  });

  it('reads the token from OD_WORKER_TOKEN so it stays out of the process list', async () => {
    const controller = new AbortController();
    const worker = cli({ env: { OD_WORKER_TOKEN: 'odw_wrong' }, signal: controller.signal });
    expect(await worker.run(['--server', server.baseUrl])).toBe(1);
    expect(worker.err()).toMatch(/refused/);
  });

  it('a wrong token exits non-zero with a clear message', async () => {
    const worker = cli();
    expect(await worker.run(['--server', server.baseUrl, '--token', 'odw_wrong'])).toBe(1);
    expect(worker.err()).toMatch(/refused/);
  });

  it('connecting without a server or token is a usage error', async () => {
    const worker = cli();
    expect(await worker.run(['--token', 'odw_x'])).toBe(2);
    expect(await worker.run(['--server', server.baseUrl])).toBe(2);
  });

  it('token without an action names the missing action', async () => {
    const c = cli();
    expect(await c.run(['token', '--person', 'Alice', ...daemon()])).toBe(2);
    expect(c.err()).toMatch(/token create\|revoke/);
  });

  it('token revoke removes the token; revoking again is not found', async () => {
    await createToken('Alice');
    const first = cli();
    expect(await first.run(['token', 'revoke', '--person', 'Alice', '--json', ...daemon()])).toBe(0);
    expect(JSON.parse(first.out())).toEqual({ person: 'Alice', revoked: true });
    const second = cli();
    expect(await second.run(['token', 'revoke', '--person', 'Alice', ...daemon()])).toBe(1);
    expect(second.err()).toMatch(/no worker token/);
  });
});
