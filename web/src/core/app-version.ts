import { TAG_VERSION } from '../config';

/**
 * Which version the header badge shows.
 *
 * Precedence:
 * 1. The CI-injected `TAG_VERSION` in `src/config.ts` — unless it is still the committed
 *    default `'0.0.0.0'`, i.e. nothing was injected.
 * 2. `import.meta.env.TAG_VERSION`, which `vite.config.ts` fills in for `vite dev` only
 *    (from `TAG_VERSION` or `git describe`) — dev would otherwise always show the default.
 * 3. `'0.0.0.0'`.
 */
export function appVersion(): string {
  if (TAG_VERSION && TAG_VERSION !== '0.0.0.0') return TAG_VERSION;
  const dev = import.meta.env.TAG_VERSION;
  return dev && dev !== '0.0.0.0' ? dev : '0.0.0.0';
}
