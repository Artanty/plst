import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapFeatures, overrideBootstrapFeatures, resetFeaturesConfigCache } from '../core/features';
import { FeatureSlot, resetLoadedScripts } from './FeatureSlot';

// Vitest runs without `globals: true`, so @testing-library/react never registers its
// auto-cleanup — without this tests leak into each other. The wrapper's module-level caches
// would leak the first test's config/script state into the rest, so they are reset too.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetFeaturesConfigCache();
  overrideBootstrapFeatures(bootstrapFeatures(''));
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

  it('renders nothing when the script fails to load (a feature never breaks the page)', async () => {
    stubFetch();
    const { container } = render(
      <FeatureSlot slot="app-version" fallback={<span>fallback</span>} />,
    );
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    injectedScripts()[0].dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(container.querySelector('deploy-info')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('renders nothing (never throws) when the config request fails', async () => {
    stubFetch(false);
    const { container } = render(<FeatureSlot slot="app-version" fallback={<span>x</span>} />);
    await vi.waitFor(() => expect(container.textContent).toBe('x'));
    expect(injectedScripts()).toHaveLength(0);
  });

  it('renders nothing (never throws) when the config body has no features key', async () => {
    // found live: a 200 with a foreign body crashed the tree at config.features.filter
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ users: [] }) })),
    );
    const { container } = render(<FeatureSlot slot="app-version" fallback={<span>x</span>} />);
    await vi.waitFor(() => expect(container.textContent).toBe('x'));
    expect(injectedScripts()).toHaveLength(0);
  });
});

describe('bootstrap (pre-backend) slots', () => {
  it('bootstrapFeatures builds the app-init wake-up v2 row + app-infra script-only rows', () => {
    expect(bootstrapFeatures('')).toEqual([]);
    expect(bootstrapFeatures('https://feat.example//')).toEqual([
      {
        slot: 'app-init',
        id: 'wake-up',
        element: 'wake-server',
        baseUrl: 'https://feat.example',
        version: 'v2',
        namespace: 'js-web',
      },
      { slot: 'app-infra', id: 'bus', baseUrl: 'https://feat.example', version: 'v1', namespace: 'js-web' },
      { slot: 'app-infra', id: 'global-loading', baseUrl: 'https://feat.example', version: 'v1', namespace: 'js-web' },
      { slot: 'app-infra', id: 'http-gate', baseUrl: 'https://feat.example', version: 'v2', namespace: 'js-web' },
    ]);
  });

  it('mounts a bootstrap slot without waiting for /api/features (pending fetch)', async () => {
    // The fetch never resolves: the sleeping-backend case the bootstrap exists for.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    overrideBootstrapFeatures(bootstrapFeatures('https://feat.example'));
    const { container } = render(
      <FeatureSlot slot="app-init" attrs={{ target: 'https://back.example', project: 'plst' }} />,
    );
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    expect(injectedScripts()[0].getAttribute('src')).toBe('https://feat.example/wake-up/v2/js-web/');
    injectedScripts()[0].dispatchEvent(new Event('load'));
    const el = await vi.waitFor(() => {
      const found = container.querySelector('wake-server');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(el.getAttribute('target')).toBe('https://back.example');
  });

  it('app-infra loads every script-only row and renders no elements', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    overrideBootstrapFeatures(bootstrapFeatures('https://feat.example'));
    const { container } = render(<FeatureSlot slot="app-infra" />);
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(3));
    expect(injectedScripts().map((s) => s.getAttribute('src'))).toEqual([
      'https://feat.example/bus/v1/js-web/',
      'https://feat.example/global-loading/v1/js-web/',
      'https://feat.example/http-gate/v2/js-web/',
    ]);
    injectedScripts().forEach((s) => s.dispatchEvent(new Event('load')));
    expect(container.textContent).toBe(''); // their side effects ARE the feature
  });

  it('mounts a bootstrap slot even when the config request fails outright', async () => {
    stubFetch(false);
    overrideBootstrapFeatures(bootstrapFeatures('https://feat.example'));
    const { container } = render(<FeatureSlot slot="app-init" />);
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    injectedScripts()[0].dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(container.querySelector('wake-server')).not.toBeNull());
  });

  it("a backend row still governs slots the bootstrap doesn't cover", async () => {
    stubFetch();
    overrideBootstrapFeatures(bootstrapFeatures('https://feat.example'));
    const { container } = render(<FeatureSlot slot="app-version" />);
    await vi.waitFor(() => expect(injectedScripts()).toHaveLength(1));
    expect(injectedScripts()[0].getAttribute('src')).toBe(
      'https://feat.example/version-display/v3/js-web/',
    );
    injectedScripts()[0].dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(container.querySelector('deploy-info')).not.toBeNull());
  });
});
