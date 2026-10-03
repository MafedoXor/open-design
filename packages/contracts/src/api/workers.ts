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
