import { useEffect, useState } from 'react';
import { apiBase, featBaseUrl } from '../config';
import { normalizeBase } from './http';

/** One remote feature the app can mount into a named slot (see layout/FeatureSlot.tsx).
 * Mirrors the mock `GET /api/features` payload in back/src/server.ts — keep both in sync
 * until the configuration GUI owns the data. */
export interface FeatureConfig {
  /** The app's named mount point — what `<FeatureSlot slot="…">` matches. */
  slot: string;
  /** feat feature name (directory under feat's features/). */
  id: string;
  /** The custom element name the feature's bundle defines — OPTIONAL: script-only
   * features (bus, http-gate, …) load their bundle and render nothing. */
  element?: string;
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

/**
 * Slots that must load at boot WITHOUT the backend: the sleeping snapdeploy backend
 * cannot serve `/api/features` before wake-up answers, so these rows are baked in from
 * the build-time `FEAT_BACK_URL` (web/.env) instead of fetched. FeatureSlot resolves
 * bootstrap rows first; backend rows stay authoritative for everything else.
 *
 * Two slots:
 * - `app-init` — wake-up v2 in MANUAL mode: resident but dormant. It only serves bus
 *   `wake-up` requests; the http-gate sends them when apiFetch sees a 503. (v1 woke on
 *   page load — a snapdeploy wake POST per visit, against a rate-limited API.)
 * - `app-infra` — script-only features, no element: the bus (request/reply transport),
 *   the gate config's recovery provider target is set in core/feat-gate.ts.
 */
export function bootstrapFeatures(featUrl: string): FeatureConfig[] {
  featUrl = featUrl.replace(/\/+$/, '');
  if (!featUrl) return [];
  const row = (id: string, version: string, element?: string): FeatureConfig => ({
    slot: 'app-infra',
    id,
    ...(element ? { element } : {}),
    baseUrl: featUrl,
    version,
    namespace: 'js-web',
  });
  return [
    {
      slot: 'app-init',
      id: 'wake-up',
      element: 'wake-server',
      baseUrl: featUrl,
      version: 'v2',
      namespace: 'js-web',
    },
    row('bus', 'v1'),
    row('global-loading', 'v1'),
    row('http-gate', 'v2'),
  ];
}

/** The app's baked-in rows: empty when FEAT_BACK_URL is unset (e.g. vitest — specs use
 * overrideBootstrapFeatures() instead, the build-time env is baked and not stubbable). */
export let BOOTSTRAP_FEATURES = bootstrapFeatures(featBaseUrl());

/** Test hook: swap the baked-in bootstrap rows. */
export function overrideBootstrapFeatures(rows: FeatureConfig[]) {
  BOOTSTRAP_FEATURES = rows;
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
