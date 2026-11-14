/**
 * Build-time config for the feat http-gate (feat feature `http-gate/v1/js-web`),
 * set as a global BEFORE the gate's bundle loads (FeatureSlot mounts it in the
 * `app-infra` slot). The gate never fetches config at runtime — feature contract.
 *
 * The recovery provider is feat `wake-up` v2 in `manual` mode (also app-infra): the
 * first 503 out of apiFetch parks/holds traffic, the gate requests `wake-up` over the
 * bus, the container wakes, parked requests retry once. global-loading (app-infra)
 * shows its blocking backdrop meanwhile — the gate signals it, not us.
 *
 * Dev (local back): no 503s ever match, the gate is a no-op passthrough.
 */
import { apiBase, featBaseUrl } from '../config';
import { normalizeBase } from './http';

/** Absolute URL of the app's own backend — the thing a 503 means is asleep. */
export function gateWakeTarget(): string {
  return normalizeBase(apiBase()) || window.location.origin;
}

declare global {
  interface Window {
    FEAT_GATE_CONFIG?: unknown;
  }
}

export function installFeatGateConfig(): void {
  window.FEAT_GATE_CONFIG = {
    rules: [{ on: 'ERROR', trigger: 503 }],
    recovery: { event: 'wake-up', payload: { target: gateWakeTarget(), project: 'plst' } },
    // bus default is 5s; a snapdeploy cold start runs ~3 min — keep above wake-up's budget
    timeoutMs: 200000,
  };
}

/**
 * apiFetch waits on this before its FIRST request: the app's boot fetches race the
 * app-infra script loads, and a 503 that slips past before http-gate exists is a dead
 * user-visible error for no reason (found live: /api/users failed while the gate was
 * still loading). Bounded at 3s; without FEAT_BACK_URL (dev/tests) it resolves at once.
 */
let gateReady: Promise<void> | null = null;

export function waitForFeatGate(): Promise<void> {
  if (window.featGate || !featBaseUrl()) return Promise.resolve();
  if (!gateReady) {
    gateReady = new Promise((resolve) => {
      const started = Date.now();
      (function poll() {
        if (window.featGate || Date.now() - started > 3000) return resolve();
        setTimeout(poll, 50);
      })();
    });
  }
  return gateReady;
}
