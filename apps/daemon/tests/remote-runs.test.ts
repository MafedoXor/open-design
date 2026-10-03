import { describe, expect, it } from 'vitest';
import { WORKER_RUN_EVENTS, type WorkerHelloRequest } from '@open-design/contracts';
import { createWorkerRegistry, type WorkerChannel } from '../src/workers/worker-registry.js';
import {
  createRemoteRunDispatcher,
  WorkerOfflineError,
  type RemoteAgentProcess,
} from '../src/workers/remote-runs.js';

const hello: WorkerHelloRequest = { hostname: 'pc', platform: 'darwin', agents: [] };

function recordingChannel() {
  const sent: Array<{ event: string; data: unknown }> = [];
  const channel: WorkerChannel = {
    send: (event, data) => sent.push({ event, data }),
    close: () => {},
  };
  return { sent, channel };
}

function setup() {
  const registry = createWorkerRegistry({ offlineAfterMs: 60_000 });
  const alice = recordingChannel();
  const bob = recordingChannel();
  registry.connect('Alice', hello, alice.channel);
  registry.connect('Bob', hello, bob.channel);
  const dispatcher = createRemoteRunDispatcher({ registry });
  return { registry, dispatcher, alice, bob };
}

function collect(child: RemoteAgentProcess) {
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (out.stdout += chunk));
  child.stderr.on('data', (chunk: string) => (out.stderr += chunk));
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (code: number | null, signal: string | null) => resolve({ code, signal }));
  });
  return { out, closed };
}

describe('remote run dispatcher', () => {
  it('starts the run on that person\'s worker only', () => {
    const { dispatcher, alice, bob } = setup();
    dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: ['-p'], stdin: { prompt: 'hi' } });
    expect(bob.sent).toEqual([
      {
        event: WORKER_RUN_EVENTS.start,
        data: { runId: 'r1', agentId: 'claude', args: ['-p'], stdin: { prompt: 'hi' } },
      },
    ]);
    expect(alice.sent).toEqual([]);
  });

  it('refuses to start a run when the person has no live worker', () => {
    const { dispatcher } = setup();
    expect(() => dispatcher.spawn('Carol', { runId: 'r1', agentId: 'claude', args: [], stdin: 'ignore' }))
      .toThrow(WorkerOfflineError);
  });

  it('streams the worker\'s output into the process streams and closes with its exit code', async () => {
    const { dispatcher } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: 'ignore' });
    const { out, closed } = collect(child);
    expect(dispatcher.output('Bob', 'r1', [{ stream: 'stdout', data: 'one\n' }])).toBe(true);
    expect(dispatcher.output('Bob', 'r1', [
      { stream: 'stderr', data: 'warn\n' },
      { stream: 'stdout', data: 'two\n' },
    ])).toBe(true);
    expect(dispatcher.exit('Bob', 'r1', { code: 3, signal: null })).toBe(true);
    expect(await closed).toEqual({ code: 3, signal: null });
    expect(out).toEqual({ stdout: 'one\ntwo\n', stderr: 'warn\n' });
    expect(child.exitCode).toBe(3);
  });

  it('ignores output and exit reported by a worker that does not own the run', async () => {
    const { dispatcher } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: 'ignore' });
    const { out } = collect(child);
    expect(dispatcher.output('Alice', 'r1', [{ stream: 'stdout', data: 'x' }])).toBe(false);
    expect(dispatcher.exit('Alice', 'r1', { code: 0, signal: null })).toBe(false);
    expect(dispatcher.output('Bob', 'nope', [{ stream: 'stdout', data: 'x' }])).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(out.stdout).toBe('');
  });

  it('forgets a run once it has exited', async () => {
    const { dispatcher } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: 'ignore' });
    const { closed } = collect(child);
    dispatcher.exit('Bob', 'r1', { code: 0, signal: null });
    await closed;
    expect(dispatcher.output('Bob', 'r1', [{ stream: 'stdout', data: 'late' }])).toBe(false);
  });

  it('a worker that could not start the agent closes with a failure and says why on stderr', async () => {
    const { dispatcher } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: 'ignore' });
    const { out, closed } = collect(child);
    dispatcher.exit('Bob', 'r1', { code: null, signal: null, error: 'claude is not installed on this PC' });
    const result = await closed;
    expect(result.code).not.toBe(0);
    expect(out.stderr).toContain('claude is not installed on this PC');
  });

  it('forwards stdin writes, stdin end and kill to the worker', async () => {
    const { dispatcher, bob } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: 'pipe' });
    expect(child.stdin).not.toBeNull();
    await new Promise<void>((resolve) => child.stdin!.write('{"a":1}\n', 'utf8', () => resolve()));
    await new Promise<void>((resolve) => child.stdin!.end(resolve));
    expect(child.kill('SIGTERM')).toBe(true);
    expect(bob.sent.slice(1)).toEqual([
      { event: WORKER_RUN_EVENTS.stdin, data: { runId: 'r1', data: '{"a":1}\n' } },
      { event: WORKER_RUN_EVENTS.stdinEnd, data: { runId: 'r1' } },
      { event: WORKER_RUN_EVENTS.kill, data: { runId: 'r1', signal: 'SIGTERM' } },
    ]);
  });

  it('has no stdin when the prompt is delivered whole at start', () => {
    const { dispatcher } = setup();
    const child = dispatcher.spawn('Bob', { runId: 'r1', agentId: 'claude', args: [], stdin: { prompt: 'p' } });
    expect(child.stdin).toBeNull();
    expect(child.pid).toBeUndefined();
  });
});
