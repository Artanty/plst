import { useEffect, useState } from 'react';
import { apiBase } from '../config';
import { normalizeBase } from './http';

/** One remote feature the app can mount into a named slot (see layout/FeatureSlot.tsx).
 * Mirrors the mock `GET /api/features` payload in back/src/server.ts — keep both in sync
 * until the configuration GUI owns the data. */
export interface FeatureConfig {
  /** The app's named mount point — what `<FeatureSlot slot="…">` matches. */
  slot: string;
  /** feat feature name (directory under feat's features/). */
  id: string;
  /** The custom element name the feature's bundle defines. */
  element: string;
  /** feat host the bundle is loaded from. */
  baseUrl: string;
  /** Pinned feature version directory (e.g. "v3"). */
  version: string;
  /** Bundle namespace segment (e.g. "js-web"). */
  namespace: string;
}

export interface FeaturesConfig {
  features: FeatureConfig[];
}

// Module-level cache: N slots render on one page but the config must be fetched once.
let configPromise: Promise<FeaturesConfig> | null = null;

/** Test hook: forget the cached config fetch. */
export function resetFeaturesConfigCache() {
  configPromise = null;
}

function fetchFeaturesConfig(): Promise<FeaturesConfig> {
  if (!configPromise) {
    configPromise = fetch(`${normalizeBase(apiBase())}/api/features`).then((res) => {
      if (!res.ok) throw new Error(`features config: HTTP ${res.status}`);
      return res.json() as Promise<FeaturesConfig>;
    });
  }
  return configPromise;
}

/** `null` while loading, undefined on failure — FeatureSlot renders nothing in both cases. */
export function useFeaturesConfig(): FeaturesConfig | null | undefined {
  const [config, setConfig] = useState<FeaturesConfig | null | undefined>(null);
  useEffect(() => {
    let alive = true;
    fetchFeaturesConfig().then(
      (value) => alive && setConfig(value),
      () => alive && setConfig(undefined),
    );
    return () => {
      alive = false;
    };
  }, []);
  return config;
}
