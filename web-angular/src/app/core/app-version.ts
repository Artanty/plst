/**
 * Build-time app version — the git tag being deployed (`TAG_VERSION` env).
 *
 * The committed default `'0.0.0.0'` keeps a local/dev build working; the deploy workflow
 * overwrites it with the real tag before the build, exactly like it seds React's
 * `web/src/config.ts`.
 *
 * The `export const TAG_VERSION = '...';` line format is load-bearing: a deploy-time sed
 * pattern matches it exactly.
 */
export const TAG_VERSION = '0.0.0.0';

/** The injected tag, or `'0.0.0.0'` when nothing was injected (local/dev build). */
export function appVersion(): string {
  return TAG_VERSION && TAG_VERSION !== '0.0.0.0' ? TAG_VERSION : '0.0.0.0';
}
