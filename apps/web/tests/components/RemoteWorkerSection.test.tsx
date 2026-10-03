// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerStatus } from '@open-design/contracts';

import { RemoteWorkerSection } from '../../src/components/RemoteWorkerSection';
import { MY_WORKER_PERSON_STORAGE_KEY, readRunOnChoice } from '../../src/workers/worker-api';
import { I18nProvider } from '../../src/i18n';

function workerStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    person: 'Alice',
    hasToken: true,
    tokenCreatedAt: '2026-10-03T12:00:00.000Z',
    online: false,
    hostname: null,
    platform: null,
    agents: [],
    connectedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(statusFor: (person: string) => WorkerStatus) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.startsWith('/api/workers/')) {
        return json(statusFor(decodeURIComponent(url.slice('/api/workers/'.length))));
      }
      if (method === 'POST' && url === '/api/workers/tokens') {
        return json({ person: 'Alice', token: 'odw_secret123', createdAt: '2026-10-03T12:00:00.000Z', rotated: false }, 201);
      }
      if (method === 'DELETE' && url === '/api/workers/tokens/Alice') {
        return json({ person: 'Alice', revoked: true });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderSection() {
  return render(
    <I18nProvider initial="en">
      <RemoteWorkerSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RemoteWorkerSection', () => {
  it('shows my worker online with the agents found on its PC', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    stubFetch(() =>
      workerStatus({
        online: true,
        hostname: 'alice-pc',
        platform: 'darwin',
        agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.0' }],
      }),
    );
    renderSection();
    expect(await screen.findByText('Online')).toBeTruthy();
    expect(screen.getByText(/alice-pc/)).toBeTruthy();
    expect(screen.getByText(/Claude Code/)).toBeTruthy();
  });

  it('shows my worker offline', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    stubFetch(() => workerStatus());
    renderSection();
    expect(await screen.findByText('Offline')).toBeTruthy();
  });

  it('remembers the name in this browser and issues a token shown once with the connect command', async () => {
    const calls = stubFetch(() => workerStatus({ hasToken: false, tokenCreatedAt: null }));
    renderSection();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(window.localStorage.getItem(MY_WORKER_PERSON_STORAGE_KEY)).toBe('Alice'));

    fireEvent.click(await screen.findByRole('button', { name: 'Create worker token' }));
    expect(await screen.findByText('odw_secret123')).toBeTruthy();
    expect(
      screen.getByText(`OD_WORKER_TOKEN=odw_secret123 od worker --server ${window.location.origin}`),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ person: 'Alice' });
  });

  it('refuses an invalid name without saving it', async () => {
    stubFetch(() => workerStatus());
    renderSection();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '../x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Use letters, digits/)).toBeTruthy();
    expect(window.localStorage.getItem(MY_WORKER_PERSON_STORAGE_KEY)).toBeNull();
  });

  it('chooses to run new messages on my worker and remembers it in this browser', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    stubFetch(() => workerStatus({ online: true, hostname: 'alice-pc', platform: 'darwin' }));
    renderSection();
    const picker = (await screen.findByLabelText('Run new messages on')) as HTMLSelectElement;
    expect(picker.value).toBe('server');
    expect(screen.getByRole('option', { name: "Alice's worker" })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'my-worker' } });
    expect(readRunOnChoice()).toBe('my-worker');

    cleanup();
    renderSection();
    expect(((await screen.findByLabelText('Run new messages on')) as HTMLSelectElement).value).toBe('my-worker');
  });

  it('warns that runs will fail while the chosen worker is offline', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    stubFetch(() => workerStatus());
    renderSection();
    fireEvent.change(await screen.findByLabelText('Run new messages on'), { target: { value: 'my-worker' } });
    expect(await screen.findByText(/runs will fail until it reconnects/)).toBeTruthy();
  });

  it('offers no worker to run on before a name is saved', () => {
    stubFetch(() => workerStatus());
    renderSection();
    expect(screen.queryByLabelText('Run new messages on')).toBeNull();
  });

  it('revokes the token', async () => {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, 'Alice');
    const calls = stubFetch(() => workerStatus());
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});
