import { createElement, useEffect, useState, type ReactNode } from 'react';
import { BOOTSTRAP_FEATURES, useFeaturesConfig, type FeatureConfig } from '../core/features';

/**
 * A named mount point for a remote feat web-component.
 *
 * WHAT loads here comes from the features config (`GET /api/features`), except for
 * bootstrap slots (BOOTSTRAP_FEATURES) which are baked in at build time because they must
 * load before the backend can answer (app-init → wake-up). This wrapper only loads the
 * bundle and renders the element. `attrs` are the element's data — build-time values from
 * the consumer's own bundle (e.g. TAG_VERSION), never a runtime fetch.
 *
 * Failure behavior is deliberate: while the config loads or if anything fails (config,
 * script, unknown element) the slot renders nothing (or `fallback`) — a feature must never
 * break the page that hosts it.
 */

// One script per URL no matter how many slots render or re-render.
const loadedScripts = new Map<string, Promise<void>>();

/** Test hook: forget which feature scripts were already injected. */
export function resetLoadedScripts() {
  loadedScripts.clear();
}

function loadScript(url: string): Promise<void> {
  let promise = loadedScripts.get(url);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => {
        loadedScripts.delete(url); // allow a retry after e.g. a network blip
        reject(new Error(`feature script failed to load: ${url}`));
      };
      document.head.appendChild(script);
    });
    loadedScripts.set(url, promise);
  }
  return promise;
}

export function FeatureSlot({
  slot,
  attrs,
  fallback = null,
}: {
  slot: string;
  attrs?: Record<string, string>;
  fallback?: ReactNode;
}) {
  const config = useFeaturesConfig();
  // Bootstrap rows win their slot and never wait for the backend config — the whole
  // point is loading while the backend is still asleep. A slot may hold an ORDERED
  // LIST of features (know/feature-slots): every matching row loads; rows without an
  // element (script-only features like the bus or http-gate) render nothing.
  const bootstrap = BOOTSTRAP_FEATURES.filter((f) => f.slot === slot);
  const rows: FeatureConfig[] =
    bootstrap.length > 0 ? bootstrap : (config?.features.filter((f) => f.slot === slot) ?? []);

  // Still loading the config only gates NON-bootstrap slots.
  const waitingForConfig = config === null && bootstrap.length === 0;
  if (waitingForConfig) return null;

  return (
    <>
      {rows.map((feature) => (
        <SlotRow key={`${feature.id}/${feature.version}`} feature={feature} attrs={attrs} />
      ))}
      {rows.length === 0 && fallback}
    </>
  );
}

function SlotRow({
  feature,
  attrs,
}: {
  feature: FeatureConfig;
  attrs?: Record<string, string>;
}) {
  const [ready, setReady] = useState(false);

  const scriptUrl = `${feature.baseUrl}/${feature.id}/${feature.version}/${feature.namespace}/`;

  useEffect(() => {
    let alive = true;
    loadScript(scriptUrl).then(
      () => alive && setReady(true),
      () => {
        /* stay silent: the slot renders nothing */
      },
    );
    return () => {
      alive = false;
    };
  }, [scriptUrl]);

  // Script-only feature (no element): the bundle's side effects ARE the feature.
  if (!feature.element) return null;
  return ready ? createElement(feature.element, attrs) : null;
}
