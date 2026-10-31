/**
 * Where the API lives.
 *
 * `''` (default) sends `/api/...` requests to the origin serving this page — correct behind the
 * vite dev proxy (`server.proxy` in vite.config.ts) and behind a reverse proxy. A static host
 * like Surge has no `/api`, so set this to the backend's public origin (e.g.
 * `'https://api.example.com'`); the backend already answers cross-origin requests
 * (`origin: true` in `back/src/server.ts`).
 *
 * In CI the deploy workflow overwrites this value with `BACK_URL` from the root `.env`
 * ("Inject BACK_URL into src/config.ts" step) — what is committed here is only the local-dev
 * default and is never what ships to prod.
 *
 * `http.ts` normalizes the value through `normalizeBase()` (scheme-less or `http:`-without-`//`
 * typos still end up as a proper absolute URL).
 *
 * The `export const API_BASE = '...';` line format is load-bearing: the deploy workflow's sed
 * pattern matches it exactly.
 */
export const API_BASE = '';

/**
 * Build-time app version — the git tag being deployed (`TAG_VERSION` env).
 *
 * Vite does not inline `process.env.*` the way stat's Parcel build does, so the value lives in
 * this config module: the deploy workflow overwrites it with `TAG_VERSION` from the root `.env`
 * ("Inject TAG_VERSION into src/config.ts" step) before the build. Without the key the committed
 * default ships, which keeps a local/dev build working.
 *
 * The `export const TAG_VERSION = '...';` line format is load-bearing: the deploy workflow's sed
 * pattern matches it exactly.
 */
export const TAG_VERSION = '0.0.0.0';
