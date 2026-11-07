import { createElement, useEffect, useState, type ReactNode } from 'react';
import { useFeaturesConfig } from '../core/features';

/**
 * A named mount point for a remote feat web-component.
 *
 * The features config (`GET /api/features`, mock data in back/src/server.ts) decides WHAT
 * loads here (feature id, pinned version, element name); this wrapper only loads the bundle
 * and renders the element. `attrs` are the element's data — build-time values from the
 * consumer's own bundle (e.g. TAG_VERSION), never a runtime fetch.
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
  const feature = config?.features.find((f) => f.slot === slot);
  const [ready, setReady] = useState(false);

  const scriptUrl = feature
    ? `${feature.baseUrl}/${feature.id}/${feature.version}/${feature.namespace}/`
    : null;

  useEffect(() => {
    if (!scriptUrl) return;
    let alive = true;
    loadScript(scriptUrl).then(
      () => alive && setReady(true),
      () => {
        /* stay silent: the slot renders the fallback */
      },
    );
    return () => {
      alive = false;
    };
  }, [scriptUrl]);

  if (config === null) return null; // still loading
  if (config === undefined || !feature || !ready) return fallback; // failed or not mountable
  return createElement(feature.element, attrs);
}
