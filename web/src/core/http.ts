/**
 * The fetch wrapper: every request the app makes goes through here, and the `x-user-id` header is
 * attached inside it for `/api/library/*` paths — the equivalent of Angular's interceptor, and
 * testable the same way (call it, assert on what reached `fetch`).
 *
 * A header, not a cookie, so there is no CSRF surface to reason about while auth is still a
 * dropdown — and the extension sends the identical header, so the browser and the scanner share
 * one server-side code path.
 */
import { apiBase } from '../config';
import { waitForFeatGate } from './feat-gate';

const LIBRARY_PREFIX = '/api/library';

/**
 * The mirror of the old vanilla app's `normalizeBase` (removed with web-vanilla/ on 2026-10-13): an absolute URL passes
 * through (trailing slashes stripped), `http:host` gets its `//` back, and a scheme-less value
 * gets `http://`. Only `''` stays `''` — "same origin as this page" is the dev default.
 */
export function normalizeBase(base: string): string {
  const value = String(base ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  if (/^https?:/i.test(value)) return `${value.slice(0, value.indexOf(':') + 1)}//${value.slice(value.indexOf(':') + 1)}`;
  return `http://${value}`.replace(/\/+$/, '');
}

const BASE = normalizeBase(apiBase());

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(body || `${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Current user; required for library calls, ignored for everything else. */
  userId?: number;
}

/**
 * The feat http-gate (app-infra slot, core/feat-gate.ts holds its config): a 503 means
 * the snapdeploy backend is asleep — the gate parks the request, wakes the container
 * over the bus (feat wake-up v2), and retries once, showing a blocking loader meanwhile.
 * Without the gate (local dev, tests, feat host unset) this is plain fetch.
 */
declare global {
  interface Window {
    featGate?: { request: (url: string, init?: RequestInit) => Promise<Response> };
  }
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Let the http-gate bundle land first (bounded): a boot 503 before the gate exists
  // would surface as an error instead of waking the backend (see feat-gate.ts).
  await waitForFeatGate();

  const headers: Record<string, string> = {};
  if (path.startsWith(LIBRARY_PREFIX) && options.userId !== undefined) {
    headers['x-user-id'] = String(options.userId);
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const transport = window.featGate?.request ?? fetch;
  let response: Response;
  try {
    response = await transport(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    // transport() only rejects on network-level failures — the "server is not running" case.
    throw new ApiError(0, '', err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ApiError(response.status, response.statusText, body);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Turns the backend's plain-text 4xx bodies into something worth putting in the UI.
 * A body that looks like an HTML page is never shown: static hosts (Surge) answer missing
 * paths with their own branded 404 page, and dumping that markup into the app was the
 * "could not load the library: <!DOCTYPE html>…" bug. Long bodies are truncated too.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'cannot reach the plst server — is `npm start` running in back/?';
    const body = (err.body || '').trim();
    if (/^<(!doctype|html)/i.test(body)) {
      return `${err.status} ${err.statusText}: got an HTML page instead of JSON — is API_BASE (src/config.ts) pointing at the backend?`;
    }
    if (!body) return `${err.status} ${err.statusText}`;
    return body.length > 300 ? `${body.slice(0, 300)}…` : body;
  }
  return err instanceof Error ? err.message : String(err);
}
