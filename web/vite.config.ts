/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm start` in ../back listens on 3218 by default (back/.env PORT=3218); PLST_API lets you
// point the dev server at another host/port (e.g. PLST_API=http://127.0.0.1:8123 npm start).
// YAUM_API is the pre-rename name and is still honoured so an old shell profile keeps working.
const target = process.env.PLST_API || process.env.YAUM_API || 'http://localhost:3218';

/**
 * The version the header badge shows in `vite dev`.
 *
 * Only CI replaces the committed default in src/config.ts ("Inject TAG_VERSION into
 * src/config.ts"), so a dev server would otherwise always show `0.0.0.0`. Resolve it here
 * instead: TAG_VERSION from the environment if set, else the repo's current git describe
 * (`v1.0.14.0.0.17` — the nearest tag; the `-<commits>-g<sha>` tail describe appends when HEAD
 * has commits on top of it is stripped from either source, it only adds noise in a corner of
 * the header), else ''.
 */
function devTagVersion(): string {
  // `-2-gbf34827` → gone; a bare-sha fallback (no tags reachable) has no such suffix and stays.
  const stripTail = (value: string) => value.replace(/-\d+-g[0-9a-f]{4,}$/, '');
  if (process.env.TAG_VERSION) return stripTail(process.env.TAG_VERSION);
  try {
    return stripTail(
      execSync('git describe --tags --always', {
        cwd: new URL('..', import.meta.url).pathname,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim(),
    );
  } catch {
    return '';
  }
}

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  // Serve-only, and never under vitest: prod builds must ship exactly what CI injected into
  // src/config.ts (a slave-repo checkout could `git describe` a stray sha), and tests need a
  // real import.meta.env they can vi.stubEnv.
  define:
    command === 'serve' && mode !== 'test'
      ? { 'import.meta.env.TAG_VERSION': JSON.stringify(devTagVersion()) }
      : {},
  server: {
    proxy: {
      '/api': { target, changeOrigin: true, secure: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    restoreMocks: true,
  },
}));
