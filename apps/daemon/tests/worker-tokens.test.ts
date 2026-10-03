import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerTokenStore } from '../src/workers/worker-tokens.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'od-worker-tokens-'));
  filePath = path.join(dir, 'workers', 'tokens.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-10-03T12:00:00.000Z');

describe('worker token store', () => {
  it('issues a token that verifies to its person', () => {
    const store = createWorkerTokenStore({ filePath, now: fixedNow });
    const issued = store.issue('Alice');
    expect(issued.person).toBe('Alice');
    expect(issued.rotated).toBe(false);
    expect(issued.createdAt).toBe('2026-10-03T12:00:00.000Z');
    expect(store.verify(issued.token)).toBe('Alice');
  });

  it('refuses unknown and empty tokens', () => {
    const store = createWorkerTokenStore({ filePath, now: fixedNow });
    store.issue('Alice');
    expect(store.verify('odw_not-a-real-token')).toBeNull();
    expect(store.verify('')).toBeNull();
    expect(store.verify(undefined)).toBeNull();
  });

  it('keeps one token per person: issuing again rotates and invalidates the old one', () => {
    const store = createWorkerTokenStore({ filePath, now: fixedNow });
    const first = store.issue('Alice');
    const second = store.issue('Alice');
    expect(second.rotated).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(store.verify(first.token)).toBeNull();
    expect(store.verify(second.token)).toBe('Alice');
    expect(store.list()).toHaveLength(1);
  });

  it('revoking a person refuses their token afterwards', () => {
    const store = createWorkerTokenStore({ filePath, now: fixedNow });
    const issued = store.issue('Alice');
    expect(store.revoke('Alice')).toBe(true);
    expect(store.verify(issued.token)).toBeNull();
    expect(store.revoke('Alice')).toBe(false);
  });

  it('persists across store instances without writing the token itself to disk', () => {
    const issued = createWorkerTokenStore({ filePath, now: fixedNow }).issue('Bob');
    const reopened = createWorkerTokenStore({ filePath, now: fixedNow });
    expect(reopened.verify(issued.token)).toBe('Bob');
    expect(reopened.list()).toEqual([{ person: 'Bob', createdAt: '2026-10-03T12:00:00.000Z' }]);
    expect(readFileSync(filePath, 'utf8')).not.toContain(issued.token);
  });
});
