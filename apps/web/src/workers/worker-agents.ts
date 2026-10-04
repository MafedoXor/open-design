import type { AgentInfo, WorkerStatus } from '@open-design/contracts';

import { fetchWorkerStatus, readMyWorkerPerson, runTargetForNextRun } from './worker-api';

type WorkerAgents = Pick<WorkerStatus, 'online' | 'agents'>;

/**
 * The agent list as seen by a run that goes to a worker.
 *
 * Invariant: when the run goes to an online worker, an agent is available
 * exactly when that worker found it on its PC. The server's own detection says
 * nothing about the PC (a server image carries no agent CLIs), and the model
 * lists stay the server's, because they describe the agent and not where it
 * runs. An offline or unknown worker leaves the list as the server reported it.
 */
export function applyWorkerAgents(agents: AgentInfo[], worker: WorkerAgents | null): AgentInfo[] {
  if (!worker || !worker.online) return agents;
  const offered = new Map(worker.agents.map((entry) => [entry.id, entry]));
  return agents.map((agent) => {
    const found = offered.get(agent.id);
    if (!found) return { ...agent, available: false };
    return { ...agent, available: true, version: found.version ?? agent.version ?? null };
  });
}

/** The worker the next run goes to, or `null` when it runs on the server or the worker cannot be read. */
export async function workerForNextRun(): Promise<WorkerAgents | null> {
  if (runTargetForNextRun() === undefined) return null;
  const person = readMyWorkerPerson();
  if (!person) return null;
  try {
    return await fetchWorkerStatus(person);
  } catch {
    return null;
  }
}
