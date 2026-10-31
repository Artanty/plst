import { appVersion } from '../core/app-version';

/**
 * The deployed app version, shown small in the corner of the header — the React counterpart of
 * stat's `VersionDisplay`. `appVersion()` picks between the CI-injected `src/config.ts` value
 * and the git tag `vite dev` resolves (see `core/app-version.ts`).
 */
export function VersionDisplay() {
  return (
    <span className="version" title="app version">
      {appVersion()}
    </span>
  );
}
