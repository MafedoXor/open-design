import { appendFile, cp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIPPED = new Set(['.DS_Store', '.git', '.hg', 'node_modules', '.od', '.tmp']);
const MAX_SECTION_CHARS = 24_000;
const MAX_FILE_MAP_ENTRIES = 300;

async function readIfFile(file: string): Promise<string | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function firstExisting(root: string, names: string[]): Promise<{ name: string; text: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  for (const wanted of names) {
    const match = entries.find((entry) => entry.toLowerCase() === wanted.toLowerCase());
    if (!match) continue;
    const text = await readIfFile(path.join(root, match));
    if (text !== null) return { name: match, text };
  }
  return null;
}

async function listFiles(root: string, dir = '', out: string[] = []): Promise<string[]> {
  if (out.length >= MAX_FILE_MAP_ENTRIES) return out;
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name)) continue;
    const rel = path.posix.join(dir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) await listFiles(root, rel, out);
    else if (out.length < MAX_FILE_MAP_ENTRIES) out.push(rel);
  }
  return out;
}

function clip(text: string): string {
  return text.length > MAX_SECTION_CHARS
    ? `${text.slice(0, MAX_SECTION_CHARS)}\n\n_(truncated — full text in \`source/original\`)_`
    : text;
}

async function collectTokenCss(root: string): Promise<string> {
  const parts: string[] = [];
  const styles = await readIfFile(path.join(root, 'styles.css'));
  let tokenFiles: string[] = [];
  try {
    tokenFiles = (await readdir(path.join(root, 'tokens'))).filter((f) => f.toLowerCase().endsWith('.css')).sort();
  } catch {
    // No tokens/ directory.
  }
  for (const file of tokenFiles) {
    const text = await readIfFile(path.join(root, 'tokens', file));
    if (!text) continue;
    // The sheet now lives at the design system root, so `../x` references
    // (fonts, icons) must point into the preserved copy instead.
    const rebased = text
      .replace(/url\((['"]?)\.\.\//g, 'url($1source/original/')
      .split('\n')
      .filter((line) => !/^\s*@import\b/.test(line))
      .join('\n');
    parts.push(`/* tokens/${file} */\n${rebased.trim()}\n`);
  }
  // styles.css is usually just the @imports of the files above.
  if (styles && parts.length === 0) parts.push(`/* styles.css */\n${styles.trim()}\n`);
  return parts.join('\n');
}

/**
 * True when the folder is already a hand-written design system (a README or
 * DESIGN.md plus token CSS), as opposed to an app whose styles we have to
 * reverse-engineer. Only then is the generic import worth overriding.
 */
export async function looksLikeNativeDesignSystem(root: string): Promise<boolean> {
  const doc = await firstExisting(root, ['DESIGN.md', 'readme.md']);
  if (!doc) return false;
  return (await collectTokenCss(root)).length > 0;
}

/**
 * Restores what the generic importer discards from a native design system:
 * the author's full README/DESIGN.md/SKILL.md/docs text, every token variable,
 * and the original files (guidelines, components, UI kits) for the agent to
 * read. The generated token-contract block stays first in `tokens.css`; the
 * author's own `:root` declarations follow it so their values win.
 */
export async function overlayNativeDesignSystem(
  sourceRoot: string,
  outDir: string,
  displayName: string,
): Promise<void> {
  const main = await firstExisting(sourceRoot, ['DESIGN.md', 'readme.md']);
  if (!main) return;
  const skill = await firstExisting(sourceRoot, ['SKILL.md']);

  const sections: string[] = [`# ${displayName}`, '', clip(main.text.trim())];
  if (skill) sections.push('', `## ${skill.name}`, '', clip(skill.text.trim()));

  try {
    const docsDir = path.join(sourceRoot, 'docs');
    for (const file of (await readdir(docsDir)).filter((f) => f.toLowerCase().endsWith('.md')).sort()) {
      const text = await readIfFile(path.join(docsDir, file));
      if (text) sections.push('', `## docs/${file}`, '', clip(text.trim()));
    }
  } catch {
    // No docs/ directory.
  }

  const files = await listFiles(sourceRoot);
  sections.push(
    '',
    '## Source files',
    '',
    'The original design system is preserved verbatim under `source/original/`. Read the guideline cards, components and UI kits there before inventing new patterns.',
    '',
    ...files.map((f) => `- \`source/original/${f}\``),
  );
  await writeFile(path.join(outDir, 'DESIGN.md'), `${sections.join('\n')}\n`, 'utf8');

  await cp(sourceRoot, path.join(outDir, 'source', 'original'), {
    recursive: true,
    filter: (src) => !SKIPPED.has(path.basename(src)),
  });

  const tokenCss = await collectTokenCss(sourceRoot);
  if (tokenCss) {
    await appendFile(
      path.join(outDir, 'tokens.css'),
      `\n/* Author-defined tokens, preserved from the opened folder. */\n${tokenCss}`,
      'utf8',
    );
  }
}
