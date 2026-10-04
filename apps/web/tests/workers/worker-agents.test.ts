// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '@open-design/contracts';

import { fetchAgents, fetchAgentsStream } from '../../src/providers/registry';
import { applyWorkerAgents } from '../../src/workers/worker-agents';
import {
  MY_WORKER_PERSON_STORAGE_KEY,
  RUN_ON_STORAGE_KEY,
} from '../../src/workers/worker-api';

function agent(id: string, available: boolean, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    name: id,
    bin: id,
    available,
    models: [{ id: 'default', label: 'Default' }],
    ...extra,
  };
}

const ONLINE_WORKER = {
  online: true,
  agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.289 (Claude Code)' }],
};

describe('applyWorkerAgents', () => {
  it('offers the agents an online worker has, with the server\'s model lists', () => {
    const result = applyWorkerAgents(
      [agent('claude', false, { models: [{ id: 'sonnet', label: 'Sonnet' }] }), agent('codex', false)],
      ONLINE_WORKER,
    );
    const claude = result.find((a) => a.id === 'claude')!;
    expect(claude.available).toBe(true);
    expect(claude.version).toBe('2.1.289 (Claude Code)');
    expect(claude.models).toEqual([{ id: 'sonnet', label: 'Sonnet' }]);
  });

  it('does not offer an agent the worker lacks, even if the server has it', () => {
    const result = applyWorkerAgents([agent('claude', false), agent('codex', true)], ONLINE_WORKER);
    expect(result.find((a) => a.id === 'codex')!.available).toBe(false);
  });

  it('leaves the list alone when the worker is offline or unknown', () => {
    const agents = [agent('claude', false)];
    expect(applyWorkerAgents(agents, { online: false, agents: ONLINE_WORKER.agents })).toEqual(agents);
    expect(applyWorkerAgents(agents, null)).toEqual(agents);
  });
});

describe('agent list while running on my worker', () => {
  beforeEach(() => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'MafedoXor');
    window.localStorage.setItem(RUN_ON_STORAGE_KEY, 'my-worker');
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/agents')) {
          if (url.includes('stream=1')) {
            const record = `event: agent\ndata: ${JSON.stringify(agent('claude', false))}\n\nevent: done\ndata: {}\n\n`;
            return new Response(record, { status: 200, headers: { 'content-type': 'text/event-stream' } });
          }
          return new Response(JSON.stringify({ agents: [agent('claude', false)] }), { status: 200 });
        }
        if (url === '/api/workers/MafedoXor') {
          return new Response(JSON.stringify({ person: 'MafedoXor', ...ONLINE_WORKER }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  it('fetchAgents marks the worker\'s agents available so a model can be picked', async () => {
    stubFetch();
    const agents = await fetchAgents();
    expect(agents.find((a) => a.id === 'claude')!.available).toBe(true);
  });

  it('fetchAgentsStream does the same for each streamed agent', async () => {
    stubFetch();
    const seen: AgentInfo[] = [];
    const collected = await fetchAgentsStream({ onAgent: (a) => seen.push(a) });
    expect(seen.find((a) => a.id === 'claude')!.available).toBe(true);
    expect(collected.find((a) => a.id === 'claude')!.available).toBe(true);
  });

  it('keeps the server\'s own list when the worker status cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/agents')) {
          return new Response(JSON.stringify({ agents: [agent('claude', false)] }), { status: 200 });
        }
        return new Response('nope', { status: 500 });
      }),
    );
    const agents = await fetchAgents();
    expect(agents.find((a) => a.id === 'claude')!.available).toBe(false);
  });
});

describe('agent list while running on the server', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is untouched and never asks for worker status', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents')) {
        return new Response(JSON.stringify({ agents: [agent('claude', false)] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const agents = await fetchAgents();
    expect(agents.find((a) => a.id === 'claude')!.available).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
