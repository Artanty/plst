/**
 * Where the API lives — resolution order (see `apiBase()`):
 *
 * 1. THIS constant — the deploy workflow's sed may overwrite the line below with the real
 *    backend origin ("Inject BACK_URL into src/config.ts" step). The
 *    `export const API_BASE = '...';` line format is load-bearing: the sed pattern matches it
 *    exactly, so do not restructure that line.
 * 2. `import.meta.env.BACK_URL` — build-time value from `web/.env` (dotenv via
 *    `vite.config.ts`, ALL modes). Dev default: `http://localhost:3218`. On deploy the
 *    slave-repo `.env` carries `BACK_URL` and the build bakes it in — no manual step.
 * 3. `''` — same-origin: `/api/...` goes to the origin serving this page (vite dev proxy /
 *    reverse proxy).
 *
 * The backend answers cross-origin requests (`origin: true` in `back/src/server.ts`).
 * Consumers use `apiBase()`; `http.ts` normalizes the result through `normalizeBase()`
 * (scheme-less or `http:`-without-`//` typos still end up as a proper absolute URL).
 */
export const API_BASE = '';

/** The effective API origin: CI sed > web/.env BACK_URL > same-origin. */
export function apiBase(): string {
  return API_BASE || ((import.meta.env.BACK_URL as string | undefined) ?? '') || '';
}

/**
 * The feat host for pre-backend features — build-time only (web/.env FEAT_BACK_URL).
 *
 * The backend cannot serve `/api/features` before it is awake, so slots that must load
 * at boot regardless of the backend (app-init → wake-up) get their bundle URL baked in
 * from here, not from the backend config. Empty string = no bootstrap features.
 */
export function featBaseUrl(): string {
  return ((import.meta.env.FEAT_BACK_URL as string | undefined) ?? '').replace(/\/+$/, '');
}

/**
 * Build-time app version — the git tag being deployed (`TAG_VERSION` env).
 *
 * The `export const TAG_VERSION = '...';` line format is load-bearing: the deploy workflow's
 * sed pattern matches it exactly, so do not restructure that line.
 *
 * Consumers use `apiVersion()`, which falls back to `import.meta.env.TAG_VERSION` — the value
 * `vite dev` computes (git describe, DEV-ONLY define in vite.config.ts) — so a dev server
 * shows the repo's current version instead of a blind `0.0.0.0`. A production build ships
 * exactly what CI injected into this constant; the fallback then never fires.
 */
export const TAG_VERSION = '0.0.0.0';

/** The effective displayed version: CI sed (prod) > vite dev git-describe > '0.0.0.0'. */
export function apiVersion(): string {
  if (TAG_VERSION && TAG_VERSION !== '0.0.0.0') return TAG_VERSION;
  const dev = (import.meta.env.TAG_VERSION as string | undefined) ?? '';
  return dev && dev !== '0.0.0.0' ? dev : '0.0.0.0';
}
