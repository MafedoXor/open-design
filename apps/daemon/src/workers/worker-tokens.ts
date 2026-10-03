import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerTokenCreateResponse } from '@open-design/contracts';

/**
 * One worker token per person, persisted as a SHA-256 hash so the file on
 * disk cannot be replayed as a credential. The plain token exists only in the
 * `issue` result.
 *
 * The token is the only lock on the worker bridge (a worker holding it can
 * receive that person's runs), so it carries 256 bits of randomness.
 */
export interface WorkerTokenStore {
  /** Issues a fresh token for `person`, replacing any token they already had. */
  issue(person: string): WorkerTokenCreateResponse;
  /** Deletes the person's token. Returns false when they had none. */
  revoke(person: string): boolean;
  /** Returns the person a token belongs to, or null for an unknown token. */
  verify(token: string | null | undefined): string | null;
  /** When the person's current token was issued, or null when they have none. */
  createdAt(person: string): string | null;
  list(): Array<{ person: string; createdAt: string }>;
}

interface StoredToken {
  person: string;
  tokenHash: string;
  createdAt: string;
}

interface TokenFile {
  version: 1;
  tokens: StoredToken[];
}

export interface CreateWorkerTokenStoreOptions {
  /** Must live under the daemon data root; the caller resolves it. */
  filePath: string;
  now?: () => Date;
}

const TOKEN_PREFIX = 'odw_';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function readTokenFile(filePath: string): StoredToken[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<TokenFile>;
  if (!Array.isArray(parsed.tokens)) return [];
  return parsed.tokens.filter(
    (entry): entry is StoredToken =>
      typeof entry?.person === 'string'
      && typeof entry.tokenHash === 'string'
      && typeof entry.createdAt === 'string',
  );
}

function writeTokenFile(filePath: string, tokens: StoredToken[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const body: TokenFile = { version: 1, tokens };
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function createWorkerTokenStore({
  filePath,
  now = () => new Date(),
}: CreateWorkerTokenStoreOptions): WorkerTokenStore {
  let tokens = readTokenFile(filePath);

  return {
    issue(person) {
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const createdAt = now().toISOString();
      const rotated = tokens.some((entry) => entry.person === person);
      tokens = [
        ...tokens.filter((entry) => entry.person !== person),
        { person, tokenHash: hashToken(token), createdAt },
      ];
      writeTokenFile(filePath, tokens);
      return { person, token, createdAt, rotated };
    },
    revoke(person) {
      const next = tokens.filter((entry) => entry.person !== person);
      if (next.length === tokens.length) return false;
      tokens = next;
      writeTokenFile(filePath, tokens);
      return true;
    },
    verify(token) {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
      const tokenHash = hashToken(token);
      return tokens.find((entry) => entry.tokenHash === tokenHash)?.person ?? null;
    },
    createdAt(person) {
      return tokens.find((entry) => entry.person === person)?.createdAt ?? null;
    },
    list() {
      return tokens.map(({ person, createdAt }) => ({ person, createdAt }));
    },
  };
}
