import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetFeaturesConfigCache } from '../core/features';
import { FeatureSlot, resetLoadedScripts } from './FeatureSlot';

// Vitest runs without `globals: true`, so @testing-library/react never registers its
// auto-cleanup — without this tests leak into each other. The wrapper's module-level caches
// would leak the first test's config/script state into the rest, so they are reset too.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetFeaturesConfigCache();
  resetLoadedScripts();
  document.head.replaceChildren();
});

const CONFIG = {
  features: [
    {
      slot: 'app-version',
      id: 'version-display',
      element: 'deploy-info',
      baseUrl: 'https://feat.example',
      version: 'v3',
      namespace: 'js-web',
    },
    {
      slot: 'elsewhere',
      id: 'other',
      element: 'other-el',
      baseUrl: 'https://feat.example',
      version: 'v1',
      namespace: 'js-web',
    },
  ],
};

function stubFetch(ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(ok ? { ok: true, json: () => Promise.resolve(CONFIG) } : { ok: false }),
    ),
  );
}

// jsdom never executes (and never fires load/error for) injected scripts, so each test
// decides the outcome by dispatching the event on the appended script node itself.
function injectedScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll('script')).filter((node) =>
    node.getAttribute('src')?.includes('feat.example'),
  );
}

describe('FeatureSlot', () => {
  it('injects the configured bundle script and mounts the element with attrs', async () => {
    stubFetch();
    const { container } = render(
      <FeatureSlot slot="app-version" attrs={{ version: '1.2.3', project: 'plst' }} />,
    );
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    expect(injectedScripts()[0].getAttribute('src')).toBe(
      'https://feat.example/version-display/v3/js-web/',
    );
    injectedScripts()[0].dispatchEvent(new Event('load'));
    const el = await vi.waitFor(() => {
      const found = container.querySelector('deploy-info');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(el.getAttribute('version')).toBe('1.2.3');
    expect(el.getAttribute('project')).toBe('plst');
  });

  it('renders nothing when the config has no entry for the slot', async () => {
    stubFetch();
    const { container } = render(<FeatureSlot slot="nope" />);
    await vi.waitFor(() => expect(container.textContent).toBe(''));
    expect(injectedScripts()).toHaveLength(0);
  });

  it('renders the fallback when the script fails to load', async () => {
    stubFetch();
    const { container } = render(
      <FeatureSlot slot="app-version" fallback={<span>fallback</span>} />,
    );
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    injectedScripts()[0].dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(container.textContent).toBe('fallback'));
    expect(container.querySelector('deploy-info')).toBeNull();
  });

  it('renders nothing (never throws) when the config request fails', async () => {
    stubFetch(false);
    const { container } = render(<FeatureSlot slot="app-version" fallback={<span>x</span>} />);
    await vi.waitFor(() => expect(container.textContent).toBe('x'));
    expect(injectedScripts()).toHaveLength(0);
  });
});
