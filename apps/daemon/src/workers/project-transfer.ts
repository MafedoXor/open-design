import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c as tarCreate, t as tarList, x as tarExtract } from 'tar';
import {
  isWorkerTransferExcludedName,
  isWorkerTransferExcludedPath,
  WORKER_CHANGES_BASE_ENTRY,
  WORKER_CHANGES_DELETED_ENTRY,
  WORKER_CHANGES_FILES_PREFIX,
  WORKER_CHANGES_NOT_SENT_ENTRY,
  WORKER_TRANSFER_MAX_FILE_BYTES,
  type WorkerRunChangesResponse,
  type WorkerRunConflict,
} from '@open-design/contracts';
import { isReservedProjectFilePath, validateProjectPath } from '../projects.js';

/**
 * Moving a run's project between the server and a worker PC, both ways.
 *
 * Server → PC: the whole project as a gzip tar (`packProject`), unpacked into
 * the run's working copy (`unpackProject`).
 * PC → server: only what the agent created, changed or deleted
 * (`collectProjectChanges` + `packProjectChanges`), applied to the project by
 * `applyProjectChanges`.
 *
 * Invariants:
 * - Only regular files travel. Symlinks are never sent either way, so neither
 *   side can be pointed at a path outside its project through a link.
 * - The daemon's own bookkeeping inside a project (file versions, live
 *   artifacts), `node_modules` and `.git` at any depth, and files over
 *   `WORKER_TRANSFER_MAX_FILE_BYTES` are not copied to the PC and are never
 *   written from it.
 * - The server writes or deletes nothing unless every path in the archive
 *   stays inside the project, also after following any symlink on the server.
 * - The server never overwrites or deletes a file that changed on the server
 *   since the worker received it. It keeps its own file, saves the agent's
 *   version beside it, and reports the conflict.
 */

/** Hash a snapshot records for a file too large to transfer; it is neither sent nor treated as deleted. */
const OVERSIZED = 'oversized';
/** `currentState` of a directory; like `OVERSIZED`, it never equals a content hash. */
const DIRECTORY = 'directory';

/** Project files keyed by project path (`/`-separated), valued by content hash. */
export type ProjectSnapshot = Map<string, string>;

export interface ProjectChanges {
  /** Created or changed files, by project path. */
  written: string[];
  deleted: string[];
  /** For each written and deleted path, its hash when the worker received the project, or `null` when it was not there. */
  base: Record<string, string | null>;
  /** Files the agent created or grew past the size cap; they are kept back. */
  notSent: string[];
}

/** The changes archive must not decompress past this. */
export const MAX_PROJECT_CHANGES_BYTES = 512 * 1024 * 1024;

export class ProjectChangesRejectedError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'ProjectChangesRejectedError';
  }
}

function isSymlinkEntry(entry: unknown): boolean {
  const type = (entry as { type?: string } | null)?.type;
  return type === 'SymbolicLink' || type === 'Link';
}

/**
 * The project as a gzip tar stream, for a worker to unpack. `onNotCopied`
 * hears each path left out under the transfer rules: an excluded directory
 * (as `dir/`, its contents unvisited) or a file over the size cap.
 */
export function packProject(
  projectDir: string,
  { onNotCopied, maxFileBytes = WORKER_TRANSFER_MAX_FILE_BYTES }: {
    onNotCopied?: (projectPath: string) => void;
    maxFileBytes?: number;
  } = {},
): Readable {
  return tarCreate(
    {
      gzip: true,
      cwd: projectDir,
      portable: true,
      filter: (entryPath, entryStat) => {
        const stat = entryStat as fs.Stats;
        if (stat.isSymbolicLink?.() || isReservedProjectFilePath(entryPath)) return false;
        const projectPath = entryPath.replace(/^\.\//, '');
        if (projectPath === '.' || projectPath === '') return true;
        if (isWorkerTransferExcludedName(path.posix.basename(projectPath))) {
          onNotCopied?.(stat.isDirectory?.() ? `${projectPath}/` : projectPath);
          return false;
        }
        if (stat.isFile?.() && stat.size > maxFileBytes) {
          onNotCopied?.(projectPath);
          return false;
        }
        return true;
      },
    },
    ['.'],
  ) as unknown as Readable;
}

/** Unpacks a `packProject` stream into `targetDir`, which must exist. */
export async function unpackProject(archive: Readable, targetDir: string): Promise<void> {
  await pipeline(archive, tarExtract({ cwd: targetDir, filter: (_path, entry) => !isSymlinkEntry(entry) }));
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Every regular file under `dir` that a transfer may carry, with its content
 * hash. Excluded directories are skipped; a file over the size cap is
 * recorded without its content, so it is neither sent nor read as deleted.
 */
export async function snapshotProject(
  dir: string,
  { maxFileBytes = WORKER_TRANSFER_MAX_FILE_BYTES }: { maxFileBytes?: number } = {},
): Promise<ProjectSnapshot> {
  const snapshot: ProjectSnapshot = new Map();
  const walk = async (relative: string) => {
    const entries = await fs.promises.readdir(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (isWorkerTransferExcludedName(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const file = path.join(dir, child);
        const { size } = await fs.promises.stat(file);
        snapshot.set(child, size > maxFileBytes ? OVERSIZED : await hashFile(file));
      }
    }
  };
  await walk('');
  return snapshot;
}

/** What changed in `dir` since `before` was taken. */
export async function collectProjectChanges(
  dir: string,
  before: ProjectSnapshot,
  options: { maxFileBytes?: number } = {},
): Promise<ProjectChanges> {
  const after = await snapshotProject(dir, options);
  const written = [...after]
    .filter(([file, hash]) => hash !== OVERSIZED && before.get(file) !== hash)
    .map(([file]) => file)
    .sort();
  const deleted = [...before.keys()].filter((file) => !after.has(file)).sort();
  const base: Record<string, string | null> = {};
  for (const file of [...written, ...deleted]) base[file] = before.get(file) ?? null;
  // The server never sends an oversized file, so every one here is the agent's.
  const notSent = [...after].filter(([, hash]) => hash === OVERSIZED).map(([file]) => file).sort();
  return { written, deleted, base, notSent };
}

/**
 * The changes archive for `changes`, read from `<runRoot>/project`. Writes
 * the deletion list to `<runRoot>/deleted.json` so the archive can be packed
 * straight from disk; the agent's working copy is never touched.
 */
export async function packProjectChanges(runRoot: string, changes: ProjectChanges): Promise<Buffer> {
  await fs.promises.writeFile(path.join(runRoot, WORKER_CHANGES_DELETED_ENTRY), JSON.stringify(changes.deleted));
  await fs.promises.writeFile(path.join(runRoot, WORKER_CHANGES_BASE_ENTRY), JSON.stringify(changes.base));
  await fs.promises.writeFile(path.join(runRoot, WORKER_CHANGES_NOT_SENT_ENTRY), JSON.stringify(changes.notSent));
  const entries = [
    WORKER_CHANGES_DELETED_ENTRY,
    WORKER_CHANGES_BASE_ENTRY,
    WORKER_CHANGES_NOT_SENT_ENTRY,
    ...changes.written.map((file) => `${WORKER_CHANGES_FILES_PREFIX}${file}`),
  ];
  const chunks: Buffer[] = [];
  for await (const chunk of tarCreate({ gzip: true, cwd: runRoot, portable: true }, entries)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ParsedChanges {
  files: Map<string, Buffer>;
  deleted: string[];
  /** `null` for an archive from a worker that predates conflict checks: its changes apply as before. */
  base: Record<string, string | null> | null;
  notSent: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseJsonEntry(name: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProjectChangesRejectedError(`${name} is not JSON`);
  }
}

async function readChangesArchive(archive: Readable, maxBytes: number): Promise<ParsedChanges> {
  const files = new Map<string, Buffer>();
  let deletedJson: string | null = null;
  let baseJson: string | null = null;
  let notSentJson: string | null = null;
  let total = 0;
  let failure: ProjectChangesRejectedError | null = null;
  const reject = (error: ProjectChangesRejectedError) => {
    failure ??= error;
  };
  const parser = tarList({
    onReadEntry: (entry) => {
      const name = entry.path.replace(/^\.\//, '');
      const isDeletionList = name === WORKER_CHANGES_DELETED_ENTRY;
      const isBase = name === WORKER_CHANGES_BASE_ENTRY;
      const isNotSent = name === WORKER_CHANGES_NOT_SENT_ENTRY;
      const isFile = name.startsWith(WORKER_CHANGES_FILES_PREFIX) && entry.type === 'File';
      if (!isDeletionList && !isBase && !isNotSent && !isFile) return;
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) reject(new ProjectChangesRejectedError('the changes are larger than the server accepts', 413));
        else chunks.push(chunk);
      });
      entry.on('end', () => {
        const body = Buffer.concat(chunks);
        if (isDeletionList) deletedJson = body.toString('utf8');
        else if (isBase) baseJson = body.toString('utf8');
        else if (isNotSent) notSentJson = body.toString('utf8');
        else files.set(name.slice(WORKER_CHANGES_FILES_PREFIX.length), body);
      });
    },
  });
  try {
    await pipeline(archive, parser as unknown as NodeJS.WritableStream);
  } catch (error) {
    throw failure ?? new ProjectChangesRejectedError(`unreadable changes archive: ${(error as Error).message}`);
  }
  if (failure) throw failure;
  if (deletedJson === null) throw new ProjectChangesRejectedError(`the changes archive has no ${WORKER_CHANGES_DELETED_ENTRY}`);
  const deleted = parseJsonEntry(WORKER_CHANGES_DELETED_ENTRY, deletedJson);
  if (!isStringArray(deleted)) {
    throw new ProjectChangesRejectedError(`${WORKER_CHANGES_DELETED_ENTRY} must be an array of paths`);
  }
  const base = baseJson === null ? null : parseJsonEntry(WORKER_CHANGES_BASE_ENTRY, baseJson);
  if (
    base !== null
    && (typeof base !== 'object' || Array.isArray(base)
      || !Object.values(base).every((hash) => hash === null || typeof hash === 'string'))
  ) {
    throw new ProjectChangesRejectedError(`${WORKER_CHANGES_BASE_ENTRY} must map paths to a hash or null`);
  }
  const notSent = notSentJson === null ? [] : parseJsonEntry(WORKER_CHANGES_NOT_SENT_ENTRY, notSentJson);
  if (!isStringArray(notSent)) {
    throw new ProjectChangesRejectedError(`${WORKER_CHANGES_NOT_SENT_ENTRY} must be an array of paths`);
  }
  return { files, deleted, base: base as Record<string, string | null> | null, notSent };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** The real path of the deepest existing ancestor of `target`, including itself. */
async function realExistingAncestor(target: string): Promise<string> {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return await fs.promises.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
    }
  }
}

/**
 * Where project path `file` lives on disk, or a rejection when it is not a
 * plain project path or would leave the project through a symlink. The file
 * itself may be a symlink only for deletion, which removes the link.
 */
async function resolveTarget(rootReal: string, file: string, forWrite: boolean): Promise<string> {
  let normalized: string;
  try {
    normalized = validateProjectPath(file);
  } catch {
    throw new ProjectChangesRejectedError(`not a project path: ${JSON.stringify(file)}`);
  }
  const target = path.join(rootReal, ...normalized.split('/'));
  if (!isInside(rootReal, target)) throw new ProjectChangesRejectedError(`path leaves the project: ${file}`);
  const parentReal = await realExistingAncestor(path.dirname(target));
  if (!isInside(rootReal, parentReal)) throw new ProjectChangesRejectedError(`path leaves the project through a link: ${file}`);
  if (forWrite) {
    const existing = await fs.promises.lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) throw new ProjectChangesRejectedError(`will not write through a link: ${file}`);
  }
  return target;
}

/** Removes now-empty directories from `dir` up to, not including, `rootReal`. */
async function pruneEmptyParents(rootReal: string, dir: string): Promise<void> {
  for (let current = dir; current !== rootReal && isInside(rootReal, current); current = path.dirname(current)) {
    try {
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
  }
}

/**
 * What is at `target` now, comparable with a `base.json` hash: the file's
 * hash, `null` when nothing is there, or a marker that never equals a hash
 * for anything that is not a regular file within the size cap.
 */
async function currentState(target: string, maxFileBytes: number): Promise<string | null> {
  const stat = await fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile()) return stat.isDirectory() ? DIRECTORY : 'other';
  return stat.size > maxFileBytes ? OVERSIZED : hashFile(target);
}

async function writeProjectFile(target: string, body: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, body);
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Where the agent's version of conflicted project path `file` is saved:
 * beside it, as `name.worker-conflict.ext` (then `-2`, `-3`, ...), at the
 * first such path that is free or that `reusable` accepts, so a retried
 * upload does not save a second copy. `reusable` gets that path's
 * `currentState`.
 */
async function conflictCopyPath(
  rootReal: string,
  file: string,
  reusable: (current: string) => boolean,
  maxFileBytes: number,
): Promise<string> {
  const dir = path.posix.dirname(file);
  const ext = path.posix.extname(file);
  const stem = path.posix.basename(file, ext);
  for (let attempt = 1; ; attempt += 1) {
    const name = `${stem}.worker-conflict${attempt === 1 ? '' : `-${attempt}`}${ext}`;
    const candidate = dir === '.' ? name : `${dir}/${name}`;
    const current = await currentState(await resolveTarget(rootReal, candidate, true), maxFileBytes);
    if (current === null || reusable(current)) return candidate;
  }
}

/**
 * The nearest ancestor of project path `file` that exists on the server as
 * something other than a directory, or `null`. Writing `file` would have to
 * replace it, which only a deletion the server agreed to may do.
 */
async function blockingAncestor(rootReal: string, file: string): Promise<string | null> {
  const segments = file.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join('/');
    const stat = await fs.promises.lstat(path.join(rootReal, ...segments.slice(0, depth))).catch(() => null);
    if (!stat) return null;
    if (!stat.isDirectory()) return ancestor;
  }
  return null;
}

/**
 * Applies a worker's changes archive to the project at `projectDir`.
 * Daemon-owned and transfer-excluded paths in it are skipped; any other path
 * that is not a plain project path rejects the whole archive before anything
 * is written. A file that changed on the server since the worker received it
 * is kept: the agent's version is saved beside it and reported as a conflict.
 */
export async function applyProjectChanges(
  projectDir: string,
  archive: Readable,
  { maxBytes = MAX_PROJECT_CHANGES_BYTES, maxFileBytes = WORKER_TRANSFER_MAX_FILE_BYTES }: {
    maxBytes?: number;
    maxFileBytes?: number;
  } = {},
): Promise<Omit<WorkerRunChangesResponse, 'ok'>> {
  const parsed = await readChangesArchive(archive, maxBytes);
  const rootReal = await fs.promises.realpath(projectDir);
  const transferable = (file: string) => !isReservedProjectFilePath(file) && !isWorkerTransferExcludedPath(file);
  const deletions = await Promise.all(
    parsed.deleted.filter(transferable).map(async (file) => ({ file, target: await resolveTarget(rootReal, file, false) })),
  );
  const writes = await Promise.all(
    [...parsed.files]
      .filter(([file, body]) => transferable(file) && body.length <= maxFileBytes)
      .map(async ([file, body]) => ({ file, target: await resolveTarget(rootReal, file, true), body })),
  );
  // A legacy archive carries no base: its changes apply unchecked, as they always did.
  const unchanged = (file: string, current: string | null) =>
    parsed.base === null || current === (parsed.base[file] ?? null);
  const conflicts: WorkerRunConflict[] = [];
  let written = 0;
  let deleted = 0;
  // Deletions first: an agent may have replaced a directory with a file.
  for (const { file, target } of deletions) {
    const current = await currentState(target, maxFileBytes);
    if (current === null) continue;
    if (!unchanged(file, current)) {
      conflicts.push({ path: file, agentCopy: null });
      continue;
    }
    await fs.promises.rm(target, { force: true });
    await pruneEmptyParents(rootReal, path.dirname(target));
    deleted += 1;
  }
  for (const { file, target, body } of writes) {
    const agentHash = sha256(body);
    // A file the server kept where the agent made a directory: the agent's
    // files go under a conflict copy of that file's name instead.
    const blocker = await blockingAncestor(rootReal, file);
    if (blocker) {
      const copyRoot = await conflictCopyPath(rootReal, blocker, (current) => current === DIRECTORY, maxFileBytes);
      const agentCopy = `${copyRoot}${file.slice(blocker.length)}`;
      await writeProjectFile(await resolveTarget(rootReal, agentCopy, true), body);
      conflicts.push({ path: file, agentCopy });
      written += 1;
      continue;
    }
    const current = await currentState(target, maxFileBytes);
    if (current === agentHash) continue;
    if (unchanged(file, current)) {
      await writeProjectFile(target, body);
      written += 1;
      continue;
    }
    const agentCopy = await conflictCopyPath(rootReal, file, (current) => current === agentHash, maxFileBytes);
    conflicts.push({ path: file, agentCopy });
    const copyTarget = await resolveTarget(rootReal, agentCopy, true);
    if ((await currentState(copyTarget, maxFileBytes)) !== agentHash) {
      await writeProjectFile(copyTarget, body);
      written += 1;
    }
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  const notSent = parsed.notSent.filter(transferable).sort();
  return { written, deleted, conflicts, notSent };
}
