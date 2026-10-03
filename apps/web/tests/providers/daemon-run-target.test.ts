// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNS_CHANGED_EVENT, streamViaDaemon } from '../../src/providers/daemon';
import {
  MY_WORKER_PERSON_STORAGE_KEY,
  readRunOnChoice,
  runTargetForNextRun,
  writeRunOnChoice,
} from '../../src/workers/worker-api';

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function createdRunBody(): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/runs') {
      return new Response(JSON.stringify({ runId: 'run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/runs/run-1/events') {
      return sseResponse('event: end\ndata: {"code":0,"status":"succeeded"}\n\n');
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await streamViaDaemon({
    agentId: 'claude',
    history: [{ id: '1', role: 'user', content: 'make a poster' }],
    systemPrompt: '',
    signal: new AbortController().signal,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() },
  });
  const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run target preference', () => {
  it('runs on the server until this browser chooses its worker', () => {
    expect(readRunOnChoice()).toBe('server');
    expect(runTargetForNextRun()).toBeUndefined();
  });

  it('targets my worker once chosen, remembered in this browser', () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    writeRunOnChoice('my-worker');
    expect(readRunOnChoice()).toBe('my-worker');
    expect(runTargetForNextRun()).toEqual({ kind: 'worker', person: 'Alice' });
  });

  it('a new run carries the worker target to the daemon', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    writeRunOnChoice('my-worker');
    expect((await createdRunBody()).runOn).toEqual({ kind: 'worker', person: 'Alice' });
  });

  it('a new run carries no target when running on the server', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    expect(await createdRunBody()).not.toHaveProperty('runOn');
  });
});

describe('a run the server refuses because the project is busy', () => {
  it('fails with PROJECT_BUSY and tells listeners the runs changed, so the busy notice refreshes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'PROJECT_BUSY',
        message: "This project is busy: a run on Alice's worker is still active.",
        details: { kind: 'project_busy', runId: 'run-a', projectId: 'p1', workerPerson: 'Alice' },
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const runsChanged = vi.fn();
    window.addEventListener(RUNS_CHANGED_EVENT, runsChanged);
    const onError = vi.fn();
    try {
      await streamViaDaemon({
        agentId: 'claude',
        history: [{ id: '1', role: 'user', content: 'make a poster' }],
        systemPrompt: '',
        projectId: 'p1',
        signal: new AbortController().signal,
        handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError, onAgentEvent: vi.fn() },
      });
    } finally {
      window.removeEventListener(RUNS_CHANGED_EVENT, runsChanged);
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as { code?: string }).code).toBe('PROJECT_BUSY');
    expect(runsChanged).toHaveBeenCalled();
  });
});
