// @vitest-environment jsdom
//
// Light is the default; dark and system-follow are opt-in. A stored theme must
// reach the document correctly at all three places it can arrive: the config
// parser, the runtime appearance applier, and the pre-hydration inline script
// that paints before React mounts. An unrecognised value still falls back to
// light, and `data-theme` is always present so a dark OS cannot leak through
// into a user who chose Light.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAppearanceToDocument } from '../../src/state/appearance';
import { DEFAULT_CONFIG, loadConfig } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const STORAGE_KEY = 'open-design:config';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

function persist(config: Partial<AppConfig>): void {
  store.set(STORAGE_KEY, JSON.stringify(config));
}

/** Pretend the OS is in dark mode, the way a dark-desktop user's browser is. */
function stubSystemPrefersDark(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('theme — persisted config', () => {
  beforeEach(() => {
    store.clear();
  });

  it('defaults a fresh install to the light theme', () => {
    expect(DEFAULT_CONFIG.theme).toBe('light');
    expect(loadConfig().theme).toBe('light');
  });

  it('keeps a persisted dark theme', () => {
    persist({ theme: 'dark', accentColor: '#4F46E5' });

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('keeps a persisted system theme', () => {
    stubSystemPrefersDark();
    persist({ theme: 'system' });

    expect(loadConfig().theme).toBe('system');
  });

  it('coerces an unrecognised theme to light and writes that back', () => {
    persist({ theme: 'sepia' as unknown as AppConfig['theme'] });

    expect(loadConfig().theme).toBe('light');
    const written = JSON.parse(store.get(STORAGE_KEY) ?? '{}') as Partial<AppConfig>;
    expect(written.theme).toBe('light');
  });
});

describe('theme — document', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('stamps light by default', () => {
    applyAppearanceToDocument({ accentColor: '#059669' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('stamps dark when dark is chosen, and light again when switched back', () => {
    applyAppearanceToDocument({ accentColor: '#059669', theme: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    applyAppearanceToDocument({ accentColor: '#059669', theme: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('resolves system against the OS, always to a concrete value', () => {
    stubSystemPrefersDark();

    applyAppearanceToDocument({ accentColor: '#10B981', theme: 'system' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  // Every JS theme reader in apps/web (shiki, ConnectorLogo, SketchEditor,
  // TerminalViewer, connectorBrandColor…) checks `data-theme` first and only
  // falls back to `prefers-color-scheme` when the attribute is ABSENT, so the
  // attribute always being present is what keeps Light truly light on a dark OS.
  it('keeps Light light on a dark OS', () => {
    stubSystemPrefersDark();

    applyAppearanceToDocument({ accentColor: '#10B981', theme: 'light' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('theme — accent in dark', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
  });

  // The dark token set ships a light accent family. Stamping the default
  // (dark gray) accent inline would beat it and strand `--accent-contrast` on
  // a dark fill, so the theme must own the accent unless the user chose one.
  it('lets the dark theme own the default accent', () => {
    applyAppearanceToDocument({ accentColor: '#353535', theme: 'dark' });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });

  it('still stamps the default accent in light', () => {
    applyAppearanceToDocument({ accentColor: '#353535', theme: 'light' });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#353535');
  });

  it('keeps a user-chosen accent in dark', () => {
    applyAppearanceToDocument({ accentColor: '#4f46e5', theme: 'dark' });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#4f46e5');
  });

  it('clears a stamped default accent when switching light to dark', () => {
    applyAppearanceToDocument({ accentColor: '#353535', theme: 'light' });
    applyAppearanceToDocument({ accentColor: '#353535', theme: 'dark' });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
});

describe('theme — pre-hydration script', () => {
  const layoutPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../app/layout.tsx',
  );

  function runThemeInitScript(): void {
    const source = readFileSync(layoutPath, 'utf8');
    const match = /const themeInitScript = `([^`]*)`;/.exec(source);
    if (!match?.[1]) throw new Error('themeInitScript not found in app/layout.tsx');
    // eslint-disable-next-line no-new-func
    new Function(match[1])();
  }

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
    store.clear();
  });

  it('paints light when nothing is stored', () => {
    runThemeInitScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('paints dark before hydration when the stored theme is dark', () => {
    persist({ theme: 'dark' });

    runThemeInitScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves a stored system theme against a dark OS', () => {
    stubSystemPrefersDark();
    persist({ theme: 'system' });

    runThemeInitScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('paints light for a stored light theme on a dark OS', () => {
    stubSystemPrefersDark();
    persist({ theme: 'light' });

    runThemeInitScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('leaves the default accent to the dark theme before hydration', () => {
    persist({ theme: 'dark' });

    runThemeInitScript();

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });
});
