/** Dark is the default; the light palette lives under `[data-theme="light"]` (styles.scss).
 * index.html applies the stored theme pre-paint; this module is the runtime toggle. */

const STORAGE_KEY = 'plst-theme';

export type Theme = 'dark' | 'light';

export function storedTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode etc. — the attribute alone still themes this page load */
  }
}

/** Flip and return the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = storedTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
