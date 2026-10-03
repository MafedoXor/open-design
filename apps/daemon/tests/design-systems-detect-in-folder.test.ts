import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectDesignSystemInFolder } from '../src/design-systems/detect-in-folder.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'od-detect-ds-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectDesignSystemInFolder', () => {
  it('returns null when the folder has no design-system signal', async () => {
    await writeFile(path.join(dir, 'index.html'), '<p>hi</p>');
    await writeFile(path.join(dir, 'app.css'), 'body{}');
    expect(await detectDesignSystemInFolder(dir)).toBeNull();
  });

  it('finds a DESIGN.md and imports its directory', async () => {
    await mkdir(path.join(dir, 'brand'));
    await writeFile(path.join(dir, 'brand', 'DESIGN.md'), '# brand');
    expect(await detectDesignSystemInFolder(dir)).toEqual({
      root: path.join(dir, 'brand'),
      kind: 'design-md',
    });
  });

  it('finds a design-system folder', async () => {
    await mkdir(path.join(dir, 'Design-System'));
    expect(await detectDesignSystemInFolder(dir)).toEqual({
      root: path.join(dir, 'Design-System'),
      kind: 'folder',
    });
  });

  it('falls back to a token stylesheet and imports the whole folder', async () => {
    await mkdir(path.join(dir, 'styles'));
    await writeFile(path.join(dir, 'styles', 'tokens.css'), ':root{--a:1}');
    expect(await detectDesignSystemInFolder(dir)).toEqual({ root: dir, kind: 'tokens' });
  });

  it('prefers DESIGN.md over a folder or tokens, and ignores node_modules', async () => {
    await mkdir(path.join(dir, 'node_modules', 'design-system'), { recursive: true });
    await writeFile(path.join(dir, 'tokens.css'), ':root{}');
    await writeFile(path.join(dir, 'DESIGN.md'), '# d');
    expect(await detectDesignSystemInFolder(dir)).toEqual({ root: dir, kind: 'design-md' });
  });
});
