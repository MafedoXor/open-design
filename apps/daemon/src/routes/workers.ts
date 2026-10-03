import type { Express, Request, Response } from 'express';
import {
  createApiError,
  normalizeWorkerPerson,
  WORKER_BRIDGE_CONNECT_PATH,
  WORKER_BRIDGE_HEARTBEAT_PATH,
  WORKER_BRIDGE_RUN_EXIT_ROUTE,
  WORKER_BRIDGE_RUN_OUTPUT_ROUTE,
  WORKER_BRIDGE_RUN_PROJECT_ROUTE,
  type WorkerAgentInfo,
  type WorkerRunAckResponse,
  type WorkerRunChangesResponse,
  type WorkerRunExitRequest,
  type WorkerRunOutputChunk,
  type WorkerHeartbeatRequest,
  type WorkerHeartbeatResponse,
  type WorkerHelloEvent,
  type WorkerHelloRequest,
  type WorkerStatus,
  type WorkerStatusListResponse,
  type WorkerTokenCreateRequest,
  type WorkerTokenCreateResponse,
  type WorkerTokenRevokeResponse,
} from '@open-design/contracts';
import {
  defineJsonRoute,
  err,
  mountJsonRoute,
  ok,
  sendApiError,
  type Result,
} from '../http/index.js';
import type { RouteDeps } from '../server-context.js';
import {
  applyProjectChanges,
  packProject,
  ProjectChangesRejectedError,
} from '../workers/project-transfer.js';
import type { RemoteRunDispatcher } from '../workers/remote-runs.js';
import type { WorkerRegistry } from '../workers/worker-registry.js';
import type { WorkerTokenStore } from '../workers/worker-tokens.js';

/**
 * Remote worker routes.
 *
 * Two audiences, two locks:
 * - `/api/workers/*` is management (issue/revoke a person's token, read
 *   status) for the UI and `od worker`. It sits behind the daemon's normal
 *   API protection like every other `/api` route.
 * - `/api/worker-bridge/*` is where a worker on someone's PC connects
 *   outbound. It authenticates with the worker token alone, so the API-token
 *   middleware lets it through (see `isWorkerBridgePath`).
 */

export interface WorkerRouteDeps {
  tokens: WorkerTokenStore;
  registry: WorkerRegistry;
}

export interface RegisterWorkerRoutesDeps extends RouteDeps<'http'>, WorkerRouteDeps {
  runs: RemoteRunDispatcher;
  heartbeatIntervalMs: number;
  pingIntervalMs: number;
}

/** Whether an `/api`-relative path is a worker-bridge endpoint (`req.path` under `app.use('/api')`). */
export function isWorkerBridgePath(apiRelativePath: string): boolean {
  return apiRelativePath.startsWith('/worker-bridge/');
}

function workerStatusFor(deps: WorkerRouteDeps, person: string): WorkerStatus {
  const tokenCreatedAt = deps.tokens.createdAt(person);
  return {
    person,
    hasToken: tokenCreatedAt !== null,
    tokenCreatedAt,
    ...deps.registry.status(person),
  };
}

function parsePersonParam(raw: { params: Record<string, string> }): Result<string> {
  const person = normalizeWorkerPerson(raw.params.person);
  return person ? ok(person) : err(createApiError('BAD_REQUEST', 'invalid person name'));
}

export const listWorkersRoute = defineJsonRoute<void, WorkerStatusListResponse, WorkerRouteDeps>({
  method: 'get',
  path: '/api/workers',
  parse: () => ok(undefined),
  handle: (_input, deps) => {
    const people = new Set([
      ...deps.tokens.list().map((entry) => entry.person),
      ...deps.registry.onlinePeople(),
    ]);
    const workers = [...people]
      .sort((a, b) => a.localeCompare(b))
      .map((person) => workerStatusFor(deps, person));
    return ok({ workers });
  },
});

export const getWorkerRoute = defineJsonRoute<string, WorkerStatus, WorkerRouteDeps>({
  method: 'get',
  path: '/api/workers/:person',
  parse: parsePersonParam,
  handle: (person, deps) => ok(workerStatusFor(deps, person)),
});

export const createWorkerTokenRoute = defineJsonRoute<string, WorkerTokenCreateResponse, WorkerRouteDeps>({
  method: 'post',
  path: '/api/workers/tokens',
  requireSameOrigin: true,
  successStatus: 201,
  parse: (raw) => {
    const person = normalizeWorkerPerson((raw.body as Partial<WorkerTokenCreateRequest> | null)?.person);
    return person
      ? ok(person)
      : err(createApiError('BAD_REQUEST', 'person must be 1-64 letters, digits, spaces, dots, dashes or underscores'));
  },
  handle: (person, deps) => {
    const issued = deps.tokens.issue(person);
    // The previous token is dead now; a worker still using it must not stay connected.
    if (issued.rotated) deps.registry.disconnectPerson(person);
    return ok(issued);
  },
});

export const revokeWorkerTokenRoute = defineJsonRoute<string, WorkerTokenRevokeResponse, WorkerRouteDeps>({
  method: 'delete',
  path: '/api/workers/tokens/:person',
  requireSameOrigin: true,
  parse: parsePersonParam,
  handle: (person, deps) => {
    if (!deps.tokens.revoke(person)) {
      return err(createApiError('NOT_FOUND', `no worker token for ${person}`));
    }
    deps.registry.disconnectPerson(person);
    return ok({ person, revoked: true });
  },
});

function bearerToken(req: Request): string | null {
  const match = /^Bearer[\t ]+(\S+)[\t ]*$/i.exec(req.get('authorization') ?? '');
  return match?.[1] ?? null;
}

function parseAgents(value: unknown): WorkerAgentInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((agent): agent is Record<string, unknown> => !!agent && typeof agent === 'object')
    .filter((agent) => typeof agent.id === 'string' && agent.id.length > 0)
    .slice(0, 100)
    .map((agent) => ({
      id: String(agent.id).slice(0, 100),
      name: typeof agent.name === 'string' ? agent.name.slice(0, 200) : String(agent.id),
      version: typeof agent.version === 'string' ? agent.version.slice(0, 100) : null,
    }));
}

function parseHello(body: unknown): WorkerHelloRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  return {
    hostname: typeof input.hostname === 'string' ? input.hostname.slice(0, 255) : '',
    platform: typeof input.platform === 'string' ? input.platform.slice(0, 64) : '',
    agents: parseAgents(input.agents),
  };
}

function parseOutputChunks(body: unknown): WorkerRunOutputChunk[] | null {
  const chunks = (body as { chunks?: unknown } | null)?.chunks;
  if (!Array.isArray(chunks)) return null;
  const parsed: WorkerRunOutputChunk[] = [];
  for (const chunk of chunks) {
    const { stream, data } = (chunk ?? {}) as Record<string, unknown>;
    if ((stream !== 'stdout' && stream !== 'stderr') || typeof data !== 'string') return null;
    parsed.push({ stream, data });
  }
  return parsed;
}

function parseExit(body: unknown): WorkerRunExitRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  return {
    code: typeof input.code === 'number' && Number.isInteger(input.code) ? input.code : null,
    signal: typeof input.signal === 'string' ? input.signal.slice(0, 32) : null,
    ...(typeof input.error === 'string' && input.error ? { error: input.error.slice(0, 2_000) } : {}),
  };
}

function refuseWorkerToken(res: Response): void {
  sendApiError(res, 401, createApiError('UNAUTHORIZED', 'worker token is invalid or has been revoked'));
}

export function registerWorkerRoutes(app: Express, options: RegisterWorkerRoutesDeps): void {
  const deps: WorkerRouteDeps = { tokens: options.tokens, registry: options.registry };
  const adapter = { resolvedPortRef: options.http.resolvedPortRef };
  mountJsonRoute(app, listWorkersRoute, deps, adapter);
  mountJsonRoute(app, createWorkerTokenRoute, deps, adapter);
  mountJsonRoute(app, revokeWorkerTokenRoute, deps, adapter);
  mountJsonRoute(app, getWorkerRoute, deps, adapter);

  // The worker's outbound channel: a long-lived server-sent-event response.
  // Online lasts while this response stays open and heartbeats keep arriving.
  app.post(WORKER_BRIDGE_CONNECT_PATH, (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const write = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => write('ping', {}), options.pingIntervalMs);
    ping.unref?.();
    const { sessionId } = options.registry.connect(person, parseHello(req.body), {
      send: write,
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        res.end();
      },
    });
    res.on('close', () => {
      closed = true;
      clearInterval(ping);
      options.registry.disconnect(sessionId);
    });

    const helloEvent: WorkerHelloEvent = {
      sessionId,
      person,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      pingIntervalMs: options.pingIntervalMs,
      liveRunIds: options.runs.liveRunIds(person),
    };
    write('hello', helloEvent);
  });

  app.post(WORKER_BRIDGE_HEARTBEAT_PATH, (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);
    const sessionId = (req.body as Partial<WorkerHeartbeatRequest> | null)?.sessionId;
    if (typeof sessionId !== 'string' || !options.registry.heartbeat(sessionId, person)) {
      return sendApiError(res, 404, createApiError('NOT_FOUND', 'worker session is not active; reconnect'));
    }
    const beat: WorkerHeartbeatResponse = { ok: true };
    res.status(200).json(beat);
  });

  // A worker running a run it was handed reports the agent's output, in
  // order, then its exit. Only the person the run was handed to may report.
  const runGone = (res: Response) =>
    sendApiError(res, 404, createApiError('NOT_FOUND', 'no active run with this id for this worker'));
  const ack: WorkerRunAckResponse = { ok: true };

  app.post(WORKER_BRIDGE_RUN_OUTPUT_ROUTE, (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);
    const chunks = parseOutputChunks(req.body);
    if (!chunks) return sendApiError(res, 400, createApiError('BAD_REQUEST', 'chunks must be [{ stream, data }]'));
    if (!options.runs.output(person, String(req.params.runId), chunks)) return runGone(res);
    res.status(200).json(ack);
  });

  app.post(WORKER_BRIDGE_RUN_EXIT_ROUTE, (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);
    if (!options.runs.exit(person, String(req.params.runId), parseExit(req.body))) return runGone(res);
    res.status(200).json(ack);
  });

  // The run's project travels to the worker before the agent starts, and the
  // agent's changes come back before the exit report, while the run is live.
  // What the copy left out and which changes conflicted are recorded on the
  // run, so its summary can explain both.
  // Both bodies are gzip tars, so the global JSON parser leaves them alone and
  // nothing is read before the worker token has been checked.
  app.get(WORKER_BRIDGE_RUN_PROJECT_ROUTE, (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);
    const runId = String(req.params.runId);
    const projectDir = options.runs.projectDir(person, runId);
    if (!projectDir) return runGone(res);
    const archive = packProject(projectDir, {
      onNotCopied: (projectPath) => options.runs.noteNotCopied(person, runId, projectPath),
    });
    archive.once('error', (error) => {
      if (!res.headersSent) {
        sendApiError(res, 500, createApiError('INTERNAL_ERROR', `could not pack the project: ${error.message}`));
      } else {
        res.destroy(error);
      }
    });
    res.status(200).setHeader('content-type', 'application/gzip');
    archive.pipe(res);
  });

  app.post(WORKER_BRIDGE_RUN_PROJECT_ROUTE, async (req: Request, res: Response) => {
    const person = options.tokens.verify(bearerToken(req));
    if (!person) return refuseWorkerToken(res);
    const runId = String(req.params.runId);
    const projectDir = options.runs.projectDir(person, runId);
    if (!projectDir) return runGone(res);
    try {
      const applied = await applyProjectChanges(projectDir, req);
      options.runs.noteChangesApplied(person, runId, applied);
      const body: WorkerRunChangesResponse = { ok: true, ...applied };
      res.status(200).json(body);
    } catch (error) {
      if (error instanceof ProjectChangesRejectedError) {
        const code = error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
        return sendApiError(res, error.status, createApiError(code, error.message));
      }
      sendApiError(res, 500, createApiError('INTERNAL_ERROR', `could not apply the changes: ${(error as Error).message}`));
    }
  });
}
