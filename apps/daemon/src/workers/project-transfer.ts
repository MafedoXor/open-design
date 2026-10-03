import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c as tarCreate, t as tarList, x as tarExtract } from 'tar';
import {
  WORKER_CHANGES_DELETED_ENTRY,
  WORKER_CHANGES_FILES_PREFIX,
  type WorkerRunChangesResponse,
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
 *   artifacts) is not copied to the PC and is never written from it.
 * - The server writes or deletes nothing unless every path in the archive
 *   stays inside the project, also after following any symlink on the server.
 */

/** Project files keyed by project path (`/`-separated), valued by content hash. */
export type ProjectSnapshot = Map<string, string>;

export interface ProjectChanges {
  /** Created or changed files, by project path. */
  written: string[];
  deleted: string[];
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

/** The project as a gzip tar stream, for a worker to unpack. */
export function packProject(projectDir: string): Readable {
  return tarCreate(
    {
      gzip: true,
      cwd: projectDir,
      portable: true,
      filter: (entryPath, stat) =>
        !(stat as fs.Stats).isSymbolicLink?.() && !isReservedProjectFilePath(entryPath),
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

/** Every regular file under `dir`, with its content hash. */
export async function snapshotProject(dir: string): Promise<ProjectSnapshot> {
  const snapshot: ProjectSnapshot = new Map();
  const walk = async (relative: string) => {
    const entries = await fs.promises.readdir(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) snapshot.set(child, await hashFile(path.join(dir, child)));
    }
  };
  await walk('');
  return snapshot;
}

/** What changed in `dir` since `before` was taken. */
export async function collectProjectChanges(dir: string, before: ProjectSnapshot): Promise<ProjectChanges> {
  const after = await snapshotProject(dir);
  return {
    written: [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file).sort(),
    deleted: [...before.keys()].filter((file) => !after.has(file)).sort(),
  };
}

/**
 * The changes archive for `changes`, read from `<runRoot>/project`. Writes
 * the deletion list to `<runRoot>/deleted.json` so the archive can be packed
 * straight from disk; the agent's working copy is never touched.
 */
export async function packProjectChanges(runRoot: string, changes: ProjectChanges): Promise<Buffer> {
  await fs.promises.writeFile(path.join(runRoot, WORKER_CHANGES_DELETED_ENTRY), JSON.stringify(changes.deleted));
  const entries = [
    WORKER_CHANGES_DELETED_ENTRY,
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
}

async function readChangesArchive(archive: Readable, maxBytes: number): Promise<ParsedChanges> {
  const files = new Map<string, Buffer>();
  let deletedJson: string | null = null;
  let total = 0;
  let failure: ProjectChangesRejectedError | null = null;
  const reject = (error: ProjectChangesRejectedError) => {
    failure ??= error;
  };
  const parser = tarList({
    onReadEntry: (entry) => {
      const name = entry.path.replace(/^\.\//, '');
      const isDeletionList = name === WORKER_CHANGES_DELETED_ENTRY;
      const isFile = name.startsWith(WORKER_CHANGES_FILES_PREFIX) && entry.type === 'File';
      if (!isDeletionList && !isFile) return;
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) reject(new ProjectChangesRejectedError('the changes are larger than the server accepts', 413));
        else chunks.push(chunk);
      });
      entry.on('end', () => {
        const body = Buffer.concat(chunks);
        if (isDeletionList) deletedJson = body.toString('utf8');
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
  let deleted: unknown;
  try {
    deleted = JSON.parse(deletedJson);
  } catch {
    throw new ProjectChangesRejectedError(`${WORKER_CHANGES_DELETED_ENTRY} is not JSON`);
  }
  if (!Array.isArray(deleted) || !deleted.every((item) => typeof item === 'string')) {
    throw new ProjectChangesRejectedError(`${WORKER_CHANGES_DELETED_ENTRY} must be an array of paths`);
  }
  return { files, deleted };
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
 * Applies a worker's changes archive to the project at `projectDir`.
 * Daemon-owned paths in it are skipped; any other path that is not a plain
 * project path rejects the whole archive before anything is written.
 */
export async function applyProjectChanges(
  projectDir: string,
  archive: Readable,
  { maxBytes = MAX_PROJECT_CHANGES_BYTES }: { maxBytes?: number } = {},
): Promise<Omit<WorkerRunChangesResponse, 'ok'>> {
  const parsed = await readChangesArchive(archive, maxBytes);
  const rootReal = await fs.promises.realpath(projectDir);
  const owned = (file: string) => !isReservedProjectFilePath(file);
  const deletions = await Promise.all(
    parsed.deleted.filter(owned).map((file) => resolveTarget(rootReal, file, false)),
  );
  const writes = await Promise.all(
    [...parsed.files].filter(([file]) => owned(file)).map(async ([file, body]) => ({
      target: await resolveTarget(rootReal, file, true),
      body,
    })),
  );
  // Deletions first: an agent may have replaced a directory with a file.
  for (const target of deletions) {
    await fs.promises.rm(target, { force: true });
    await pruneEmptyParents(rootReal, path.dirname(target));
  }
  for (const { target, body } of writes) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, body);
  }
  return { written: writes.length, deleted: deletions.length };
}
