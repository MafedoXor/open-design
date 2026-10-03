// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectBusyNotice } from '../../../src/components/chat/ProjectBusyNotice';
import { I18nProvider } from '../../../src/i18n';
import { RUNS_CHANGED_EVENT } from '../../../src/providers/daemon';
import { MY_WORKER_PERSON_STORAGE_KEY, writeRunOnChoice } from '../../../src/workers/worker-api';

let activeRuns: Array<{ id: string; status: string; workerPerson?: string | null }> = [];
let requests: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  activeRuns = [];
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('/api/runs?')) {
      return new Response(JSON.stringify({ runs: activeRuns }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderNotice() {
  return render(
    <I18nProvider initial="en">
      <ProjectBusyNotice projectId="p1" />
    </I18nProvider>,
  );
}

describe('ProjectBusyNotice', () => {
  it('names whose worker holds the project, read from the server so it survives a reload', async () => {
    activeRuns = [{ id: 'r1', status: 'running', workerPerson: 'Alice' }];
    renderNotice();
    expect(await screen.findByText(/a run on Alice's worker is active/)).toBeTruthy();
    expect(requests[0]).toContain('projectId=p1');
  });

  it('shows nothing while only server runs share the project', async () => {
    activeRuns = [{ id: 'r1', status: 'running', workerPerson: null }];
    renderNotice();
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('project-busy-notice')).toBeNull();
  });

  it('is busy for me when my runs go to my worker and another run is active', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Bob');
    writeRunOnChoice('my-worker');
    activeRuns = [{ id: 'r1', status: 'running', workerPerson: null }];
    renderNotice();
    expect(await screen.findByText(/another run is active/)).toBeTruthy();
  });

  it('clears once the holding run ends and the runs change', async () => {
    activeRuns = [{ id: 'r1', status: 'running', workerPerson: 'Alice' }];
    renderNotice();
    await screen.findByTestId('project-busy-notice');
    activeRuns = [];
    act(() => {
      window.dispatchEvent(new Event(RUNS_CHANGED_EVENT));
    });
    await waitFor(() => expect(screen.queryByTestId('project-busy-notice')).toBeNull());
  });
});
