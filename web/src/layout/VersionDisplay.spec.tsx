import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAG_VERSION } from '../config';
import { VersionDisplay } from './VersionDisplay';

// Vitest runs without `globals: true`, so @testing-library/react never registers its
// auto-cleanup — without this the first test's DOM leaks into the second.
afterEach(cleanup);

describe('VersionDisplay', () => {
  it('shows the build-time TAG_VERSION from src/config.ts', () => {
    render(<VersionDisplay />);
    expect(screen.getByTitle('app version').textContent).toBe(TAG_VERSION);
  });

  it('falls back to 0.0.0.0 when the config value is empty', async () => {
    // Simulates a build where neither CI nor the committed default supplied a tag: the component
    // must still print something rather than an empty corner.
    vi.resetModules();
    vi.doMock('../config', () => ({ API_BASE: '', TAG_VERSION: '' }));
    const { VersionDisplay: EmptyVersionDisplay } = await import('./VersionDisplay');
    render(<EmptyVersionDisplay />);
    expect(screen.getByTitle('app version').textContent).toBe('0.0.0.0');
    vi.doUnmock('../config');
    vi.resetModules();
  });
});
