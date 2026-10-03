import {
  WORKER_BRIDGE_CONNECT_PATH,
  WORKER_BRIDGE_HEARTBEAT_PATH,
  type WorkerHeartbeatRequest,
  type WorkerHelloEvent,
  type WorkerHelloRequest,
} from '@open-design/contracts';

/**
 * The worker side of the bridge: `od worker` on a person's PC.
 *
 * It only ever opens outbound HTTP requests to the server: one long-lived
 * event stream and short heartbeat POSTs. Runs arrive as events on that
 * stream and their output goes back as POSTs (see worker-runs.ts). Nothing
 * listens on the PC. A dropped channel is retried with backoff; a refused
 * token is not, because retrying cannot fix it.
 */

export class WorkerTokenRejectedError extends Error {
  constructor() {
    super('the server refused this worker token (wrong, rotated, or revoked)');
    this.name = 'WorkerTokenRejectedError';
  }
}

export type WorkerClientEvent =
  | { type: 'connected'; hello: WorkerHelloEvent }
  | { type: 'disconnected'; reason: string }
  | { type: 'reconnecting'; delayMs: number };

export interface RunWorkerOptions {
  serverUrl: string;
  token: string;
  /** Reports this PC (hostname, agents). Called on every (re)connect so the agent list stays current. */
  describe: () => Promise<WorkerHelloRequest>;
  signal?: AbortSignal;
  /** Delay before reconnect attempt `attempt` (1-based). */
  reconnectDelayMs?: (attempt: number) => number;
  onEvent?: (event: WorkerClientEvent) => void;
  /** Every other event the server sends on the channel (runs to execute), with its JSON payload. */
  onServerEvent?: (event: string, data: unknown) => void;
}

/** Silence allowed before the first event arrives. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Pings the server may miss before the channel is presumed dead. */
const MISSED_PINGS_BEFORE_RECONNECT = 3;

const defaultReconnectDelayMs = (attempt: number) => Math.min(30_000, 1_000 * 2 ** (attempt - 1));

interface SseEvent {
  event: string;
  data: string;
}

/** Splits a server-sent-event byte stream into events. */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      yield { event, data: data.join('\n') };
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function deliverServerEvent(options: RunWorkerOptions, message: SseEvent): void {
  if (!options.onServerEvent) return;
  let data: unknown;
  try {
    data = JSON.parse(message.data);
  } catch {
    return;
  }
  try {
    options.onServerEvent(message.event, data);
  } catch {
    // A handler bug must not tear down the channel every other run depends on.
  }
}

/**
 * Holds one connection open until it drops. Resolves with why it ended;
 * throws `WorkerTokenRejectedError` when the server refuses the token.
 */
async function connectOnce(
  base: string,
  options: RunWorkerOptions,
  onConnected: () => void,
): Promise<string> {
  const connection = new AbortController();
  const abortConnection = () => connection.abort();
  options.signal?.addEventListener('abort', abortConnection, { once: true });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let rejected = false;
  let endReason = 'connection closed by server';

  const armWatchdog = (ms: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      endReason = 'no data from server; presuming the connection is dead';
      connection.abort();
    }, ms);
  };
  const authorization = `Bearer ${options.token}`;

  try {
    let hello: WorkerHelloRequest;
    try {
      hello = await options.describe();
    } catch (error) {
      return `could not inspect this PC: ${error instanceof Error ? error.message : String(error)}`;
    }
    let response: Response;
    try {
      response = await fetch(`${base}${WORKER_BRIDGE_CONNECT_PATH}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(hello),
        signal: connection.signal,
      });
    } catch (error) {
      return `cannot reach server: ${error instanceof Error ? (error.cause as Error | undefined)?.message ?? error.message : String(error)}`;
    }
    if (response.status === 401) throw new WorkerTokenRejectedError();
    if (!response.ok || !response.body) return `server answered HTTP ${response.status}`;

    let silenceBudgetMs = HANDSHAKE_TIMEOUT_MS;
    armWatchdog(silenceBudgetMs);
    try {
      for await (const message of readServerSentEvents(response.body)) {
        armWatchdog(silenceBudgetMs);
        if (message.event === 'ping') continue;
        if (message.event !== 'hello') {
          deliverServerEvent(options, message);
          continue;
        }
        const helloEvent = JSON.parse(message.data) as WorkerHelloEvent;
        silenceBudgetMs = helloEvent.pingIntervalMs * MISSED_PINGS_BEFORE_RECONNECT;
        armWatchdog(silenceBudgetMs);
        heartbeat = setInterval(() => {
          void fetch(`${base}${WORKER_BRIDGE_HEARTBEAT_PATH}`, {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: helloEvent.sessionId } satisfies WorkerHeartbeatRequest),
            signal: connection.signal,
          })
            .then((beat) => {
              if (beat.status === 401) rejected = true;
              if (beat.status === 401 || beat.status === 404) {
                endReason = 'server no longer recognises this session';
                connection.abort();
              }
            })
            .catch(() => {
              // A failed heartbeat is not fatal on its own; the watchdog
              // decides when the channel is gone.
            });
        }, helloEvent.heartbeatIntervalMs);
        onConnected();
        options.onEvent?.({ type: 'connected', hello: helloEvent });
        // Run handling needs it too: it says which runs the server still has.
        deliverServerEvent(options, message);
      }
    } catch (error) {
      if (!connection.signal.aborted) {
        endReason = `connection lost: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (rejected) throw new WorkerTokenRejectedError();
    return endReason;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(watchdog);
    options.signal?.removeEventListener('abort', abortConnection);
    connection.abort();
  }
}

/**
 * Keeps the worker connected until `signal` aborts (resolves) or the server
 * refuses the token (rejects with `WorkerTokenRejectedError`).
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const base = options.serverUrl.replace(/\/+$/, '');
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  let attempt = 0;
  while (!options.signal?.aborted) {
    const reason = await connectOnce(base, options, () => {
      attempt = 0;
    });
    if (options.signal?.aborted) return;
    options.onEvent?.({ type: 'disconnected', reason });
    attempt += 1;
    const delayMs = reconnectDelayMs(attempt);
    options.onEvent?.({ type: 'reconnecting', delayMs });
    await sleep(delayMs, options.signal);
  }
}
