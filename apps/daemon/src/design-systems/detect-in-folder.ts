import { readdir } from 'node:fs/promises';
import path from 'node:path';

export type DetectedDesignSystemKind = 'design-md' | 'folder' | 'tokens';

export type DetectedDesignSystemSource = {
  /** Directory to hand to `importLocalDesignSystemProject`. */
  root: string;
  kind: DetectedDesignSystemKind;
};

const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 400;

const SKIPPED_DIRS = new Set([
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.od',
  '.tmp',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const DESIGN_SYSTEM_DIR_NAMES = new Set([
  'design-system',
  'design-systems',
  'designsystem',
  'design_system',
  'tokens',
]);

const TOKEN_CSS_PATTERN = /^(design-)?(tokens?|variables|theme)([.-].*)?\.css$/i;

type Hit = { depth: number; root: string };

/**
 * Looks inside a user-opened folder for something that can seed a design
 * system, in priority order: a `DESIGN.md`, a folder named like a design
 * system, then CSS that looks like a token sheet. Returns the directory to
 * import, or null when the folder carries no such signal.
 *
 * Only the top `MAX_DEPTH` levels are walked so opening a large monorepo stays
 * cheap, and the first (shallowest) hit of each kind wins.
 */
export async function detectDesignSystemInFolder(
  baseDir: string,
): Promise<DetectedDesignSystemSource | null> {
  const found: Partial<Record<DetectedDesignSystemKind, Hit>> = {};

  const record = (kind: DetectedDesignSystemKind, depth: number, root: string) => {
    const current = found[kind];
    if (!current || depth < current.depth) found[kind] = { depth, root };
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = (await readdir(dir, { withFileTypes: true })).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        if (entry.name.toLowerCase() === 'design.md') record('design-md', depth, dir);
        else if (TOKEN_CSS_PATTERN.test(entry.name)) record('tokens', depth, baseDir);
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        const child = path.join(dir, entry.name);
        if (DESIGN_SYSTEM_DIR_NAMES.has(entry.name.toLowerCase())) record('folder', depth + 1, child);
        if (depth + 1 <= MAX_DEPTH) await walk(child, depth + 1);
      }
    }
  };

  await walk(baseDir, 0);

  for (const kind of ['design-md', 'folder', 'tokens'] as const) {
    const hit = found[kind];
    if (hit) return { root: hit.root, kind };
  }
  return null;
}
