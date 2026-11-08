/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { defineConfig } from 'vite';

// BACK_URL comes from web/.env at BUILD time (the established frontend convention: dotenv,
// no VITE_ prefixes). Dev default points straight at the backend (vite proxy in back/.env
// runs on 3218; the backend answers cross-origin via `origin: true` in back/src/server.ts).
// PLST_API/YAUM_API still override the DEV proxy target below.
// Under vitest, drop BACK_URL BEFORE dotenv runs (dotenv never overrides existing vars):
// vitest mirrors process.env into import.meta.env, and specs must not depend on the
// developer's local BACK_URL.
if (process.env.VITEST) process.env.BACK_URL = '';
dotenv.config();

/**
 * The version a DEV server shows in the version badge (import.meta.env.TAG_VERSION).
 *
 * Prod builds must ship exactly what CI seds into src/config.ts, so this is defined for
 * `vite dev` only: TAG_VERSION from the environment if set, else the repo's current git
 * describe (`v1.0.14.0.0.17` — the nearest tag; the `-<commits>-g<sha>` tail is stripped, it
 * only adds noise in a corner badge).
 */
function devTagVersion(): string {
  // `-2-gbf34827` → gone; a leading `v` → gone too (the deploy-info element adds its own,
  // and prod's injected TAG_VERSION carries no prefix — `1.0.16.0.0.27`, not `v1.…`).
  const strip = (value: string) => value.replace(/-\d+-g[0-9a-f]{4,}$/, '').replace(/^v/, '');
  if (process.env.TAG_VERSION) return strip(process.env.TAG_VERSION);
  try {
    return strip(
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
  // Dev and build bake the web/.env BACK_URL into the bundle (vitest emptied it above).
  // TAG_VERSION is a DEV-only define: prod must ship exactly what CI seds into src/config.ts.
  define:
    command === 'serve' && mode !== 'test'
      ? {
          'import.meta.env.BACK_URL': JSON.stringify(process.env.BACK_URL ?? ''),
          'import.meta.env.TAG_VERSION': JSON.stringify(devTagVersion()),
        }
      : { 'import.meta.env.BACK_URL': JSON.stringify(process.env.BACK_URL ?? '') },
  server: {
    proxy: {
      // Fallback only: without BACK_URL the app talks same-origin ('' in config.ts), and
      // /api must still reach the backend in dev. PLST_API overrides the target.
      '/api': {
        target: process.env.PLST_API || process.env.YAUM_API || 'http://localhost:3218',
        changeOrigin: true,
        secure: false,
      },
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
