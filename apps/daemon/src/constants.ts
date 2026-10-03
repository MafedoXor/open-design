export const ACTIVE_CONTEXT_TTL_MS = 5 * 60 * 1000;

// Remote workers. A worker heartbeats every interval; one that misses
// heartbeats for `WORKER_OFFLINE_AFTER_MS` shows as offline even if its TCP
// connection is still half-open (a sleeping laptop).
export const WORKER_HEARTBEAT_INTERVAL_MS = 10 * 1000;
export const WORKER_PING_INTERVAL_MS = 15 * 1000;
export const WORKER_OFFLINE_AFTER_MS = 30 * 1000;
