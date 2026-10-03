import os from 'node:os';
import type {
  WorkerHelloRequest,
  WorkerStatus,
  WorkerStatusListResponse,
  WorkerTokenCreateResponse,
  WorkerTokenRevokeResponse,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';
import { runWorker, WorkerTokenRejectedError } from './worker-client.js';

const USAGE = `Usage:
  od worker --server <url> [--token <token>]
      Connect this PC to an Open Design server as your worker and stay
      connected until interrupted. The connection is outbound only; nothing
      listens on this PC. Prefer OD_WORKER_TOKEN over --token so the token
      stays out of the process list. OD_WORKER_SERVER may replace --server.

  od worker status [--person <name>] [--json] [--daemon-url <url>]
      Show whether a person's worker is online and which agents it offers.
      Without --person, list every person's worker.

  od worker token create --person <name> [--json] [--daemon-url <url>]
      Issue the worker token for a person. A person has one token; creating
      it again rotates it and disconnects the worker using the old one.
      The token is printed once and cannot be read back later.

  od worker token revoke --person <name> [--json] [--daemon-url <url>]
      Delete a person's worker token and disconnect their worker.

Options:
  --json               Print the server's JSON response.
  --daemon-url <url>   Open Design server for status/token commands.
                       When the server requires an API token, set OD_API_TOKEN.`;

export interface WorkerCliDeps {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reports this PC to the server. Defaults to probing the installed agent CLIs. */
  describe: () => Promise<WorkerHelloRequest>;
  /** Stops a running worker. Defaults to SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

const STRING_FLAGS = new Set(['server', 'token', 'person', 'daemon-url']);
const BOOLEAN_FLAGS = new Set(['json', 'help', 'h']);

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

class UsageError extends Error {}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
    } else if (STRING_FLAGS.has(key)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '') throw new UsageError(`--${key} needs a value`);
      flags[key] = value;
    } else {
      throw new UsageError(`unknown option --${key}`);
    }
  }
  return { positional, flags };
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === 'string' ? value : undefined;
}

export async function describeThisPc(): Promise<WorkerHelloRequest> {
  const { detectAgents } = await import('../runtimes/detection.js');
  const detected = await detectAgents();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    agents: detected
      .filter((agent) => agent.available)
      .map((agent) => ({ id: agent.id, name: agent.name, version: agent.version ?? null })),
  };
}

function signalFromProcess(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}

async function connect(parsed: ParsedArgs, deps: WorkerCliDeps): Promise<number> {
  const serverUrl = stringFlag(parsed, 'server') ?? deps.env.OD_WORKER_SERVER;
  const token = stringFlag(parsed, 'token') ?? deps.env.OD_WORKER_TOKEN;
  if (!serverUrl || !token) {
    throw new UsageError('od worker needs --server <url> and a token (--token or OD_WORKER_TOKEN)');
  }
  deps.stderr(`[worker] connecting to ${serverUrl}\n`);
  try {
    await runWorker({
      serverUrl,
      token,
      describe: async () => {
        const hello = await deps.describe();
        const names = hello.agents.map((agent) => agent.name).join(', ') || 'none';
        deps.stderr(`[worker] agents on this PC: ${names}\n`);
        return hello;
      },
      signal: deps.signal ?? signalFromProcess(),
      onEvent: (event) => {
        if (event.type === 'connected') {
          deps.stderr(`[worker] connected as ${event.hello.person}\n`);
        } else if (event.type === 'disconnected') {
          deps.stderr(`[worker] disconnected: ${event.reason}\n`);
        } else {
          deps.stderr(`[worker] reconnecting in ${Math.round(event.delayMs / 1000)}s\n`);
        }
      },
    });
  } catch (error) {
    if (error instanceof WorkerTokenRejectedError) {
      deps.stderr(`[worker] ${error.message}. Ask for a new token with: od worker token create --person <name>\n`);
      return 1;
    }
    throw error;
  }
  deps.stderr('[worker] stopped\n');
  return 0;
}

async function callServer<T>(
  parsed: ParsedArgs,
  deps: WorkerCliDeps,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const base = (await resolveDaemonUrl({ flagUrl: stringFlag(parsed, 'daemon-url') ?? null, env: deps.env })).replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const apiToken = deps.env.OD_API_TOKEN?.trim();
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  let response: Response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { ok: false, message: `cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    return { ok: false, message: payload?.error?.message ?? `HTTP ${response.status}` };
  }
  return { ok: true, value: payload as T };
}

function printJson(deps: WorkerCliDeps, value: unknown): void {
  deps.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function formatStatus(status: WorkerStatus): string {
  const state = status.online ? 'online' : 'offline';
  const where = status.online ? ` on ${status.hostname} (${status.platform})` : '';
  const token = status.hasToken ? '' : ' [no token]';
  const agents = status.online
    ? `\n  agents: ${status.agents.map((agent) => agent.version ? `${agent.name} ${agent.version}` : agent.name).join(', ') || 'none'}`
    : '';
  return `${status.person}: ${state}${where}${token}${agents}\n`;
}

function requirePerson(parsed: ParsedArgs): string {
  const person = stringFlag(parsed, 'person');
  if (!person) throw new UsageError('--person <name> is required');
  return person;
}

async function status(parsed: ParsedArgs, deps: WorkerCliDeps): Promise<number> {
  const person = stringFlag(parsed, 'person');
  if (person) {
    const result = await callServer<WorkerStatus>(parsed, deps, 'GET', `/api/workers/${encodeURIComponent(person)}`);
    if (!result.ok) return fail(deps, result.message);
    if (parsed.flags.json) printJson(deps, result.value);
    else deps.stdout(formatStatus(result.value));
    return 0;
  }
  const result = await callServer<WorkerStatusListResponse>(parsed, deps, 'GET', '/api/workers');
  if (!result.ok) return fail(deps, result.message);
  if (parsed.flags.json) {
    printJson(deps, result.value);
  } else if (result.value.workers.length === 0) {
    deps.stdout('No workers yet. Create a token with: od worker token create --person <name>\n');
  } else {
    deps.stdout(result.value.workers.map(formatStatus).join(''));
  }
  return 0;
}

async function token(parsed: ParsedArgs, deps: WorkerCliDeps): Promise<number> {
  const action = parsed.positional[1];
  if (action !== 'create' && action !== 'revoke') {
    throw new UsageError('expected: od worker token create|revoke --person <name>');
  }
  const person = requirePerson(parsed);
  if (action === 'create') {
    const result = await callServer<WorkerTokenCreateResponse>(parsed, deps, 'POST', '/api/workers/tokens', { person });
    if (!result.ok) return fail(deps, result.message);
    if (parsed.flags.json) {
      printJson(deps, result.value);
    } else {
      deps.stdout(`${result.value.token}\n`);
      deps.stderr(
        `${result.value.rotated ? 'Rotated' : 'Created'} the worker token for ${person}. It is shown only once.\n`
        + `On ${person}'s PC run: OD_WORKER_TOKEN=<token> od worker --server <this server's URL>\n`,
      );
    }
    return 0;
  }
  const result = await callServer<WorkerTokenRevokeResponse>(
    parsed,
    deps,
    'DELETE',
    `/api/workers/tokens/${encodeURIComponent(person)}`,
  );
  if (!result.ok) return fail(deps, result.message);
  if (parsed.flags.json) printJson(deps, result.value);
  else deps.stdout(`Revoked the worker token for ${person}.\n`);
  return 0;
}

function fail(deps: WorkerCliDeps, message: string): number {
  deps.stderr(`od worker: ${message}\n`);
  return 1;
}

export async function runWorkerCli(args: string[], partialDeps: Partial<WorkerCliDeps> = {}): Promise<number> {
  const deps: WorkerCliDeps = {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    describe: describeThisPc,
    ...partialDeps,
  };
  try {
    const parsed = parseArgs(args);
    const command = parsed.positional[0];
    if (parsed.flags.help || command === 'help') {
      deps.stdout(`${USAGE}\n`);
      return 0;
    }
    if (command === undefined || command === 'connect') return await connect(parsed, deps);
    if (command === 'status') return await status(parsed, deps);
    if (command === 'token') return await token(parsed, deps);
    throw new UsageError(`unknown command: od worker ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`od worker: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
}
