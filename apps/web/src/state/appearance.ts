import { getOpenDesignHost } from '@open-design/host';
import type { AppTheme } from '../types';

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

export const DEFAULT_ACCENT_COLOR = '#353535';
export const ACCENT_SWATCHES = [
  DEFAULT_ACCENT_COLOR,
  '#202020',
  '#848484',
  '#87ea5c',
  '#0d5400',
  '#1A74FF',
  '#FFBA12',
  '#FF7528',
  '#F04142',
] as const;

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAccentColor(value: unknown): string {
  return normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}

function accentVars(accentColor: string): Record<(typeof ACCENT_VARS)[number], string> {
  return {
    '--accent': accentColor,
    // Keep these mix ratios in sync with the pre-hydration script in app/layout.tsx.
    '--accent-strong': `color-mix(in srgb, ${accentColor} 82%, var(--text-strong))`,
    '--accent-soft': `color-mix(in srgb, ${accentColor} 12%, var(--bg-subtle))`,
    '--accent-tint': `color-mix(in srgb, ${accentColor} 6%, var(--bg-panel))`,
    '--accent-hover': `color-mix(in srgb, ${accentColor} 86%, var(--text-strong))`,
  };
}

/**
 * Light is the default; dark and system-follow are opt-in.
 *
 * `data-theme` is always stamped on `<html>` with the RESOLVED value
 * (`light` | `dark`), never `system` and never absent. Every dark rule in the
 * app is gated on `[data-theme='dark']`, or on the attribute being absent
 * (`html:not([data-theme])` in CSS), or falls back to `prefers-color-scheme`
 * when it is missing (`shiki`, `ConnectorLogo`, `SketchEditor`,
 * `TerminalViewer`, `connectorBrandColor`, `MentionNode`). Stamping it
 * unconditionally is what keeps a dark OS from leaking into a user who chose
 * Light.
 */
export const DEFAULT_APP_THEME = 'light' as const satisfies AppTheme;

const APP_THEMES: readonly AppTheme[] = ['light', 'dark', 'system'];

/** Any persisted value outside the three real themes falls back to light. */
export function resolveAppTheme(persisted?: AppTheme | null): AppTheme {
  return persisted != null && APP_THEMES.includes(persisted) ? persisted : DEFAULT_APP_THEME;
}

/** The concrete look a theme preference paints right now. */
export function resolveEffectiveTheme(theme: AppTheme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyAppearanceToDocument({
  accentColor,
  theme,
}: {
  accentColor?: string;
  theme?: AppTheme | null;
}): void {
  const root = document.documentElement;
  const preference = resolveAppTheme(theme);
  root.setAttribute('data-theme', resolveEffectiveTheme(preference));
  // Desktop shell: keep the native window appearance (the macOS vibrancy
  // glass material) in step with the app theme. Without this the glass
  // follows the OS appearance, so a light app over a dark OS sat on dark
  // glass and read as a muddy gray (#94). Feature-detected — browsers and
  // older host builds have no appearance capability.
  getOpenDesignHost()?.appearance?.setTheme(preference);

  const normalized = resolveAccentColor(accentColor);
  const vars = accentVars(normalized);
  // The dark token set ships its own (light) accent family. The default accent
  // is dark gray, so stamping it inline would beat that family and leave
  // `--accent-contrast` (dark in dark mode) sitting on a dark fill. Only a
  // user-chosen accent is allowed to override the theme's.
  const themeOwnsAccent =
    root.getAttribute('data-theme') === 'dark' && normalized === DEFAULT_ACCENT_COLOR;
  for (const name of ACCENT_VARS) {
    if (themeOwnsAccent) root.style.removeProperty(name);
    else root.style.setProperty(name, vars[name]);
  }
}
