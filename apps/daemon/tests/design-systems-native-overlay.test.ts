import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  looksLikeNativeDesignSystem,
  overlayNativeDesignSystem,
} from '../src/design-systems/native-overlay.js';

let src: string;
let out: string;

beforeEach(async () => {
  src = await mkdtemp(path.join(os.tmpdir(), 'od-native-src-'));
  out = await mkdtemp(path.join(os.tmpdir(), 'od-native-out-'));
});

afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

async function seed() {
  await mkdir(path.join(src, 'tokens'));
  await mkdir(path.join(src, 'guidelines'));
  await writeFile(path.join(src, 'readme.md'), '# Pirates\nGame UI, not web.');
  await writeFile(path.join(src, 'SKILL.md'), '---\nname: x\n---\nUse tokens.');
  await writeFile(path.join(src, 'tokens', 'colors.css'), ':root{--gold:#c8a24a}');
  await writeFile(
    path.join(src, 'tokens', 'fonts.css'),
    '@import "x.css";\n@font-face{src:url(../assets/fonts/a.ttf)}',
  );
  await writeFile(path.join(src, 'guidelines', 'a.card.html'), '<p>card</p>');
  await writeFile(path.join(out, 'tokens.css'), ':root{--accent:#2563eb}\n');
}

describe('native design system overlay', () => {
  it('is only native when it has docs and token css', async () => {
    expect(await looksLikeNativeDesignSystem(src)).toBe(false);
    await seed();
    expect(await looksLikeNativeDesignSystem(src)).toBe(true);
  });

  it('keeps the author text, every token and the original files', async () => {
    await seed();
    await overlayNativeDesignSystem(src, out, 'Pirates DS');

    const design = await readFile(path.join(out, 'DESIGN.md'), 'utf8');
    expect(design).toContain('Game UI, not web.');
    expect(design).toContain('Use tokens.');
    expect(design).toContain('source/original/guidelines/a.card.html');

    const tokens = await readFile(path.join(out, 'tokens.css'), 'utf8');
    expect(tokens).toContain('--accent:#2563eb');
    expect(tokens).toContain('--gold:#c8a24a');
    expect(tokens).toContain('url(source/original/assets/fonts/a.ttf)');
    expect(tokens).not.toContain('@import');

    expect(await readFile(path.join(out, 'source/original/guidelines/a.card.html'), 'utf8')).toBe('<p>card</p>');
  });
});
