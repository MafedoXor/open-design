import { describe, expect, it } from 'vitest';

import { remapStdinPaths } from '../src/workers/worker-runs.js';

const SERVER = '/data/projects/p1';
const WIN = 'C:\Users\Admin\AppData\Local\Temp\od-worker\run-1\project';

describe('remapStdinPaths', () => {
  it('moves the project path inside a stream-json line without breaking the JSON', () => {
    const line =
      JSON.stringify({ type: 'user', message: { role: 'user', content: `edit ${SERVER}/index.html please` } }) + '\n';
    const out = remapStdinPaths(line, SERVER, WIN);
    const parsed = JSON.parse(out);
    expect(parsed.message.content).toBe(`edit ${WIN}/index.html please`);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('keeps every line of a multi-line chunk valid', () => {
    const a = JSON.stringify({ text: SERVER });
    const b = JSON.stringify({ text: 'no path' });
    const out = remapStdinPaths(`${a}\n${b}\n`, SERVER, WIN).split('\n');
    expect(JSON.parse(out[0]!).text).toBe(WIN);
    expect(out[1]).toBe(b);
  });

  it('rewrites a plain-text prompt verbatim, with no escaping', () => {
    expect(remapStdinPaths(`open ${SERVER}/a.html\nthen "quote"`, SERVER, WIN)).toBe(
      `open ${WIN}/a.html\nthen "quote"`,
    );
  });
});
