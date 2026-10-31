import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../config');
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Fresh module instance with the given committed `TAG_VERSION` from src/config.ts. */
async function versionWithConfig(tagVersion: string): Promise<string> {
  vi.doMock('../config', () => ({ API_BASE: '', TAG_VERSION: tagVersion }));
  vi.resetModules();
  const { appVersion: fresh } = await import('./app-version');
  return fresh();
}

describe('appVersion', () => {
  it('uses the CI-injected value from src/config.ts', async () => {
    vi.stubEnv('TAG_VERSION', 'v9.9.9.9.9-dev-should-not-win');
    expect(await versionWithConfig('v1.2.3.4.5')).toBe('v1.2.3.4.5');
  });

  it('falls back to the vite dev value when config still has the default', async () => {
    vi.stubEnv('TAG_VERSION', 'v1.0.14.0.0.17');
    expect(await versionWithConfig('0.0.0.0')).toBe('v1.0.14.0.0.17');
  });

  it('falls back to the vite dev value when config is empty', async () => {
    vi.stubEnv('TAG_VERSION', 'v1.0.14.0.0.17');
    expect(await versionWithConfig('')).toBe('v1.0.14.0.0.17');
  });

  it('falls back to 0.0.0.0 when neither source has a value', async () => {
    vi.stubEnv('TAG_VERSION', '');
    expect(await versionWithConfig('0.0.0.0')).toBe('0.0.0.0');
  });

  it('treats a vite dev value of 0.0.0.0 as absent too', async () => {
    vi.stubEnv('TAG_VERSION', '0.0.0.0');
    expect(await versionWithConfig('0.0.0.0')).toBe('0.0.0.0');
  });
});
