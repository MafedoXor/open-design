import { randomUUID } from 'node:crypto';
import type { WorkerHelloRequest, WorkerStatus } from '@open-design/contracts';

/** The server's end of one worker's outbound connection. */
export interface WorkerChannel {
  send(event: string, data: unknown): void;
  close(): void;
}

export type WorkerConnectionStatus = Pick<
  WorkerStatus,
  'online' | 'hostname' | 'platform' | 'agents' | 'connectedAt' | 'lastSeenAt'
>;

/**
 * Which person's worker is connected right now.
 *
 * Invariant: a person has at most one live session, and a session counts as
 * online only while its last heartbeat is younger than `offlineAfterMs`. A
 * worker whose PC sleeps or loses its network leaves a half-open connection
 * the server may not notice for minutes; the heartbeat bound is what makes it
 * show as offline in bounded time regardless.
 */
export interface WorkerRegistry {
  connect(person: string, hello: WorkerHelloRequest, channel: WorkerChannel): { sessionId: string };
  /** Refreshes a session, which `person` must own. False means the worker should reconnect. */
  heartbeat(sessionId: string, person: string): boolean;
  /** The connection behind `sessionId` closed. A newer session for the same person is untouched. */
  disconnect(sessionId: string): void;
  disconnectPerson(person: string): void;
  status(person: string): WorkerConnectionStatus;
  /** Writes an event on the person's live channel. False when they have no live worker. */
  send(person: string, event: string, data: unknown): boolean;
  /** People with a live session. */
  onlinePeople(): string[];
  /** Closes sessions that have gone quiet past the bound. */
  sweep(): void;
  closeAll(): void;
  /**
   * Called when `person`'s worker is gone for good: its connection closed or
   * went quiet and no newer session took its place. A reconnect that replaces
   * the old session does not call it.
   */
  onWorkerGone(listener: (person: string) => void): void;
}

interface Session {
  sessionId: string;
  person: string;
  hello: WorkerHelloRequest;
  channel: WorkerChannel;
  connectedAt: number;
  lastSeenAt: number;
}

export interface CreateWorkerRegistryOptions {
  offlineAfterMs: number;
  now?: () => number;
}

const OFFLINE: WorkerConnectionStatus = {
  online: false,
  hostname: null,
  platform: null,
  agents: [],
  connectedAt: null,
  lastSeenAt: null,
};

export function createWorkerRegistry({
  offlineAfterMs,
  now = () => Date.now(),
}: CreateWorkerRegistryOptions): WorkerRegistry {
  const byPerson = new Map<string, Session>();

  const isFresh = (session: Session) => now() - session.lastSeenAt <= offlineAfterMs;

  const sessionById = (sessionId: string): Session | undefined => {
    for (const session of byPerson.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  };

  const goneListeners: Array<(person: string) => void> = [];

  const drop = (session: Session, replaced = false) => {
    const wasCurrent = byPerson.get(session.person) === session;
    if (wasCurrent) byPerson.delete(session.person);
    try {
      session.channel.close();
    } catch {
      // The connection may already be gone; dropping the session is what matters.
    }
    if (wasCurrent && !replaced) {
      for (const listener of goneListeners) {
        try {
          listener(session.person);
        } catch (error) {
          console.warn('[workers] worker-gone listener failed', error);
        }
      }
    }
  };

  return {
    connect(person, hello, channel) {
      const previous = byPerson.get(person);
      const at = now();
      const session: Session = {
        sessionId: randomUUID(),
        person,
        hello,
        channel,
        connectedAt: at,
        lastSeenAt: at,
      };
      byPerson.set(person, session);
      if (previous) drop(previous, true);
      return { sessionId: session.sessionId };
    },
    heartbeat(sessionId, person) {
      const session = sessionById(sessionId);
      if (!session || session.person !== person) return false;
      if (!isFresh(session)) {
        drop(session);
        return false;
      }
      session.lastSeenAt = now();
      return true;
    },
    disconnect(sessionId) {
      const session = sessionById(sessionId);
      if (session) drop(session);
    },
    disconnectPerson(person) {
      const session = byPerson.get(person);
      if (session) drop(session);
    },
    status(person) {
      const session = byPerson.get(person);
      if (!session || !isFresh(session)) return OFFLINE;
      return {
        online: true,
        hostname: session.hello.hostname,
        platform: session.hello.platform,
        agents: session.hello.agents,
        connectedAt: new Date(session.connectedAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      };
    },
    send(person, event, data) {
      const session = byPerson.get(person);
      if (!session || !isFresh(session)) return false;
      session.channel.send(event, data);
      return true;
    },
    onlinePeople() {
      return [...byPerson.values()].filter(isFresh).map((session) => session.person);
    },
    sweep() {
      for (const session of [...byPerson.values()]) {
        if (!isFresh(session)) drop(session);
      }
    },
    onWorkerGone(listener) {
      goneListeners.push(listener);
    },
    closeAll() {
      for (const session of [...byPerson.values()]) drop(session);
    },
  };
}
