import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerWorkerRoutes, type RegisterWorkerRoutesDeps } from '../../src/routes/workers.js';
import { createRemoteRunDispatcher, type RemoteRunDispatcher } from '../../src/workers/remote-runs.js';
import { createWorkerRegistry } from '../../src/workers/worker-registry.js';
import { createWorkerTokenStore } from '../../src/workers/worker-tokens.js';

export interface WorkerTestServer {
  baseUrl: string;
  runs: RemoteRunDispatcher;
  close(): Promise<void>;
}

/** An HTTP server with only the worker routes mounted, on fast test timings. */
export async function startWorkerTestServer({
  offlineAfterMs = 30_000,
}: { offlineAfterMs?: number | undefined } = {}): Promise<WorkerTestServer> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'od-worker-server-'));
  const app = express();
  app.use(express.json());
  const resolvedPortRef = { current: 0 };
  const registry = createWorkerRegistry({ offlineAfterMs });
  const runs = createRemoteRunDispatcher({ registry });
  registerWorkerRoutes(app, {
    tokens: createWorkerTokenStore({ filePath: path.join(dataDir, 'workers', 'tokens.json') }),
    registry,
    runs,
    // The worker routes read only `resolvedPortRef` from the HTTP deps.
    http: { resolvedPortRef } as unknown as RegisterWorkerRoutesDeps['http'],
    heartbeatIntervalMs: 50,
    pingIntervalMs: 50,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  resolvedPortRef.current = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${resolvedPortRef.current}`,
    runs,
    async close() {
      registry.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Resolves once `person`'s worker shows as online, or throws after a few seconds. */
export async function waitForWorkerOnline(server: WorkerTestServer, person: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const status = (await (await fetch(`${server.baseUrl}/api/workers/${person}`)).json()) as { online?: boolean };
    if (status.online) return;
    if (Date.now() > deadline) throw new Error(`${person}'s worker did not come online`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
