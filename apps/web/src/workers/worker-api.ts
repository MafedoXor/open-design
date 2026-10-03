import type {
  WorkerStatus,
  WorkerTokenCreateResponse,
} from '@open-design/contracts';

/**
 * Which person's worker is "mine" in this browser. There is no browser login
 * on a private-network server, so the browser remembers the name; the server
 * keys worker tokens and status by it.
 */
export const MY_WORKER_PERSON_STORAGE_KEY = 'od:my-worker-person';

export function readMyWorkerPerson(): string | null {
  try {
    return window.localStorage.getItem(MY_WORKER_PERSON_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeMyWorkerPerson(person: string): void {
  try {
    window.localStorage.setItem(MY_WORKER_PERSON_STORAGE_KEY, person);
  } catch {
    // Private windows can refuse storage; the name then lasts for this page only.
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`worker request failed (${response.status})`);
  return (await response.json()) as T;
}

export async function fetchWorkerStatus(person: string): Promise<WorkerStatus> {
  return readJson(await fetch(`/api/workers/${encodeURIComponent(person)}`));
}

export async function createWorkerToken(person: string): Promise<WorkerTokenCreateResponse> {
  return readJson(
    await fetch('/api/workers/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person }),
    }),
  );
}

export async function revokeWorkerToken(person: string): Promise<void> {
  const response = await fetch(`/api/workers/tokens/${encodeURIComponent(person)}`, { method: 'DELETE' });
  // Already gone is the state the user asked for.
  if (!response.ok && response.status !== 404) {
    throw new Error(`worker request failed (${response.status})`);
  }
}

/** The command a person runs on their PC to connect it as their worker. */
export function workerConnectCommand(serverOrigin: string, token: string): string {
  return `OD_WORKER_TOKEN=${token} od worker --server ${serverOrigin}`;
}
