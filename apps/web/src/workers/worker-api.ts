import type {
  RunTarget,
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

/** Where this browser's new runs execute: on the server, or on my worker. */
export type RunOnChoice = 'server' | 'my-worker';
export const RUN_ON_STORAGE_KEY = 'od:run-on';

export function readRunOnChoice(): RunOnChoice {
  try {
    return window.localStorage.getItem(RUN_ON_STORAGE_KEY) === 'my-worker' ? 'my-worker' : 'server';
  } catch {
    return 'server';
  }
}

export function writeRunOnChoice(choice: RunOnChoice): void {
  try {
    window.localStorage.setItem(RUN_ON_STORAGE_KEY, choice);
  } catch {
    // As with the name: without storage the choice lasts for this page only.
  }
}

/**
 * The `runOn` a run started from this browser carries, or `undefined` to run
 * on the server. Choosing "my worker" is only offered once a name is saved.
 */
export function runTargetForNextRun(): RunTarget | undefined {
  if (readRunOnChoice() !== 'my-worker') return undefined;
  const person = readMyWorkerPerson();
  return person ? { kind: 'worker', person } : undefined;
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

/**
 * The command a person runs on their PC to connect it as their worker. The
 * shell is guessed from the browser's platform: PowerShell cannot read the
 * POSIX `VAR=value cmd` prefix form.
 */
export function workerConnectCommand(
  serverOrigin: string,
  token: string,
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
): string {
  if (/^win/i.test(platform)) {
    return `$env:OD_WORKER_TOKEN = "${token}"; od worker --server ${serverOrigin}`;
  }
  return `OD_WORKER_TOKEN=${token} od worker --server ${serverOrigin}`;
}
