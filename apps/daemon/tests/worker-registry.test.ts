import { describe, expect, it, vi } from 'vitest';
import { createWorkerRegistry, type WorkerChannel } from '../src/workers/worker-registry.js';

const hello = {
  hostname: 'alice-pc',
  platform: 'darwin',
  agents: [{ id: 'claude', name: 'Claude Code', version: '2.1.0' }],
};

function fakeChannel() {
  return {
    send: vi.fn<WorkerChannel['send']>(),
    close: vi.fn<WorkerChannel['close']>(),
  } satisfies WorkerChannel;
}

function setup() {
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  const registry = createWorkerRegistry({ now: () => now, offlineAfterMs: 30_000 });
  return {
    registry,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('worker registry', () => {
  it('reports a connected worker as online with its agents', () => {
    const { registry } = setup();
    registry.connect('Alice', hello, fakeChannel());
    expect(registry.status('Alice')).toEqual({
      online: true,
      hostname: 'alice-pc',
      platform: 'darwin',
      agents: hello.agents,
      connectedAt: '2026-10-03T12:00:00.000Z',
      lastSeenAt: '2026-10-03T12:00:00.000Z',
    });
  });

  it('reports an unknown person as offline', () => {
    const { registry } = setup();
    expect(registry.status('Nobody')).toEqual({
      online: false,
      hostname: null,
      platform: null,
      agents: [],
      connectedAt: null,
      lastSeenAt: null,
    });
  });

  it('goes offline once heartbeats stop for longer than the bound, and closes the channel', () => {
    const { registry, advance } = setup();
    const channel = fakeChannel();
    const session = registry.connect('Alice', hello, channel);
    advance(20_000);
    expect(registry.heartbeat(session.sessionId, 'Alice')).toBe(true);
    advance(25_000);
    registry.sweep();
    expect(registry.status('Alice').online).toBe(true);
    advance(10_000);
    registry.sweep();
    expect(registry.status('Alice').online).toBe(false);
    expect(channel.close).toHaveBeenCalled();
    expect(registry.heartbeat(session.sessionId, 'Alice')).toBe(false);
  });

  it('counts a stale session as offline even before the sweep runs', () => {
    const { registry, advance } = setup();
    registry.connect('Alice', hello, fakeChannel());
    advance(30_001);
    expect(registry.status('Alice').online).toBe(false);
  });

  it('a dropped connection is offline immediately', () => {
    const { registry } = setup();
    const session = registry.connect('Alice', hello, fakeChannel());
    registry.disconnect(session.sessionId);
    expect(registry.status('Alice').online).toBe(false);
  });

  it('a reconnect replaces the earlier session, and the earlier one closing does not take it down', () => {
    const { registry } = setup();
    const firstChannel = fakeChannel();
    const first = registry.connect('Alice', hello, firstChannel);
    const second = registry.connect('Alice', { ...hello, hostname: 'alice-laptop' }, fakeChannel());
    expect(firstChannel.close).toHaveBeenCalled();
    registry.disconnect(first.sessionId);
    expect(registry.status('Alice')).toMatchObject({ online: true, hostname: 'alice-laptop' });
    expect(registry.heartbeat(first.sessionId, 'Alice')).toBe(false);
    expect(registry.heartbeat(second.sessionId, 'Alice')).toBe(true);
  });

  it('disconnectPerson drops that person only', () => {
    const { registry } = setup();
    const alice = fakeChannel();
    registry.connect('Alice', hello, alice);
    registry.connect('Bob', { ...hello, hostname: 'bob-pc' }, fakeChannel());
    registry.disconnectPerson('Alice');
    expect(alice.close).toHaveBeenCalled();
    expect(registry.status('Alice').online).toBe(false);
    expect(registry.status('Bob').online).toBe(true);
  });

  it('heartbeat must come from the session owner', () => {
    const { registry } = setup();
    const session = registry.connect('Alice', hello, fakeChannel());
    expect(registry.heartbeat(session.sessionId, 'Bob')).toBe(false);
    expect(registry.heartbeat(session.sessionId, 'Alice')).toBe(true);
  });
});
