/**
 * Remote workers: a person's own PC that connects outbound to an Open Design
 * server and offers the agent CLIs installed there.
 *
 * Without browser login there is no account to hang a worker on, so a
 * **person** is a short display name the server issues exactly one worker
 * token for. Issuing a token for a name that already has one rotates it: the
 * previous token stops working and any worker using it is disconnected.
 */

/** Longest accepted person name, in characters. */
export const WORKER_PERSON_MAX_LENGTH = 64;

/** Letters, digits, space, dot, underscore and dash; must start with a letter or digit. */
const WORKER_PERSON_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** Returns the trimmed person name, or `null` when it is not an acceptable name. */
export function normalizeWorkerPerson(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > WORKER_PERSON_MAX_LENGTH) return null;
  return WORKER_PERSON_PATTERN.test(trimmed) ? trimmed : null;
}

/** One agent CLI the worker found on its PC. */
export interface WorkerAgentInfo {
  id: string;
  name: string;
  version: string | null;
}

/** What a worker tells the server about its PC when it connects. */
export interface WorkerHelloRequest {
  hostname: string;
  platform: string;
  agents: WorkerAgentInfo[];
}

/** First event on the worker channel, once the server has accepted the token. */
export interface WorkerHelloEvent {
  sessionId: string;
  person: string;
  /** How often the worker must call the heartbeat endpoint. */
  heartbeatIntervalMs: number;
  /**
   * How often the server writes a `ping` event on the channel. A worker that
   * hears nothing for several intervals treats the connection as dead and
   * reconnects.
   */
  pingIntervalMs: number;
}

export interface WorkerHeartbeatRequest {
  sessionId: string;
}

export interface WorkerHeartbeatResponse {
  ok: true;
}

/** Server-side view of one person's worker, shared by the UI and `od worker status`. */
export interface WorkerStatus {
  person: string;
  /** Whether a worker token currently exists for this person. */
  hasToken: boolean;
  tokenCreatedAt: string | null;
  online: boolean;
  hostname: string | null;
  platform: string | null;
  agents: WorkerAgentInfo[];
  connectedAt: string | null;
  lastSeenAt: string | null;
}

export interface WorkerStatusListResponse {
  workers: WorkerStatus[];
}

export interface WorkerTokenCreateRequest {
  person: string;
}

/** The token is returned once, here, and never again. */
export interface WorkerTokenCreateResponse {
  person: string;
  token: string;
  createdAt: string;
  /** True when this replaced an earlier token for the same person. */
  rotated: boolean;
}

export interface WorkerTokenRevokeResponse {
  person: string;
  revoked: true;
}

/** Worker-side endpoints. They authenticate with the worker token, not the API token. */
export const WORKER_BRIDGE_CONNECT_PATH = '/api/worker-bridge/connect';
export const WORKER_BRIDGE_HEARTBEAT_PATH = '/api/worker-bridge/heartbeat';

/**
 * Where a run executes. Omitted means on the server, as before. `worker`
 * hands the agent process to that person's connected worker; the server
 * still owns the run and receives its output.
 */
export type RunTarget = { kind: 'worker'; person: string };

export const RUN_TARGET_INVALID_MESSAGE = 'runOn must be { kind: "worker", person: "<name>" }';

/** Returns a well-formed run target, or `null` when the value is not one. */
export function normalizeRunTarget(value: unknown): RunTarget | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'worker') return null;
  const person = normalizeWorkerPerson(input.person);
  return person ? { kind: 'worker', person } : null;
}

/**
 * How the agent's prompt reaches its stdin on the worker: a complete prompt
 * written then closed, a pipe the server keeps writing to (`run-stdin`
 * events), or nothing.
 */
export type WorkerRunStdin = { prompt: string } | 'pipe' | 'ignore';

/**
 * The project a worker run works on. The worker downloads it into a directory
 * of its own before the agent starts (`workerBridgeRunProjectPath`) and sends
 * back what the agent changed before reporting the exit
 * (a POST to the same `workerBridgeRunProjectPath`).
 */
export interface WorkerRunProject {
  id: string;
  /**
   * The project's absolute path on the server. The worker rewrites it to its
   * own copy wherever it appears in `args` and in `OD_PROJECT_DIR`.
   */
  dir: string;
}

/**
 * The only environment variables a server may set for an agent on a worker:
 * what the agent needs to call back into the server for this run. Provider
 * credentials and every other variable come from the worker PC itself. The
 * worker supplies `OD_DAEMON_URL`, `OD_BIN` and `OD_NODE_BIN` on its own,
 * because only it knows how it reaches the server and where its `od` is.
 */
export const WORKER_RUN_ENV_KEYS = [
  'OD_TOOL_TOKEN',
  'OD_PROJECT_ID',
  'OD_PROJECT_DIR',
  'OD_WORKSPACE_ID',
  'OD_WORKSPACE_MEMBER_ID',
] as const;

export type WorkerRunEnvKey = (typeof WORKER_RUN_ENV_KEYS)[number];

/** Server → worker, on the channel: start an agent process for this run. */
export interface WorkerRunStartEvent {
  runId: string;
  /** Agent id from the registry; the worker resolves its own executable for it. */
  agentId: string;
  args: string[];
  stdin: WorkerRunStdin;
  /** Absent for a run without a project: the agent starts in an empty directory. */
  project?: WorkerRunProject;
  env?: Partial<Record<WorkerRunEnvKey, string>>;
}

/** Server → worker: more bytes for the agent's stdin (`stdin: 'pipe'` runs). */
export interface WorkerRunStdinEvent {
  runId: string;
  data: string;
}

/** Server → worker: close the agent's stdin. */
export interface WorkerRunStdinEndEvent {
  runId: string;
}

/** Server → worker: signal the agent process. */
export interface WorkerRunKillEvent {
  runId: string;
  signal: string;
}

/** Event names the server sends a worker for runs. */
export const WORKER_RUN_EVENTS = {
  start: 'run-start',
  stdin: 'run-stdin',
  stdinEnd: 'run-stdin-end',
  kill: 'run-kill',
} as const;

export interface WorkerRunOutputChunk {
  stream: 'stdout' | 'stderr';
  data: string;
}

/** Worker → server: agent output, in order. */
export interface WorkerRunOutputRequest {
  chunks: WorkerRunOutputChunk[];
}

/**
 * Worker → server: the agent process ended. `error` is set when the worker
 * could not do its part of the run: start the agent at all (for example the
 * agent CLI is not installed on the PC), copy the project to the PC, or send
 * the agent's file changes back. The run then fails.
 */
export interface WorkerRunExitRequest {
  code: number | null;
  signal: string | null;
  error?: string;
}

export interface WorkerRunAckResponse {
  ok: true;
}

/** Express route patterns for the output and exit endpoints below. */
export const WORKER_BRIDGE_RUN_OUTPUT_ROUTE = '/api/worker-bridge/runs/:runId/output';
export const WORKER_BRIDGE_RUN_EXIT_ROUTE = '/api/worker-bridge/runs/:runId/exit';

export function workerBridgeRunOutputPath(runId: string): string {
  return `/api/worker-bridge/runs/${encodeURIComponent(runId)}/output`;
}

export function workerBridgeRunExitPath(runId: string): string {
  return `/api/worker-bridge/runs/${encodeURIComponent(runId)}/exit`;
}

/**
 * GET: the run's project as a gzip tar, every regular file relative to the
 * project root. POST: the agent's changes, as a gzip tar laid out as below.
 * Both answer 404 once the run has exited or for a run without a project.
 */
export const WORKER_BRIDGE_RUN_PROJECT_ROUTE = '/api/worker-bridge/runs/:runId/project';

export function workerBridgeRunProjectPath(runId: string): string {
  return `/api/worker-bridge/runs/${encodeURIComponent(runId)}/project`;
}

/**
 * Layout of the changes archive a worker POSTs to the project route. Every
 * file the agent created or changed sits under `project/` at its project
 * path; the one top-level `deleted.json` is a JSON array of project paths the
 * agent removed. Keeping the agent's files under a prefix means no project
 * file can be mistaken for the deletion list.
 */
export const WORKER_CHANGES_FILES_PREFIX = 'project/';
export const WORKER_CHANGES_DELETED_ENTRY = 'deleted.json';

/** Server → worker: what the server applied from a changes archive. */
export interface WorkerRunChangesResponse {
  ok: true;
  written: number;
  deleted: number;
}
