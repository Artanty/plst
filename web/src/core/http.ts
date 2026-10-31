/**
 * The fetch wrapper: every request the app makes goes through here, and the `x-user-id` header is
 * attached inside it for `/api/library/*` paths — the equivalent of Angular's interceptor, and
 * testable the same way (call it, assert on what reached `fetch`).
 *
 * A header, not a cookie, so there is no CSRF surface to reason about while auth is still a
 * dropdown — and the extension sends the identical header, so the browser and the scanner share
 * one server-side code path.
 */
import { API_BASE } from '../config';

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

const BASE = normalizeBase(API_BASE);

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

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (path.startsWith(LIBRARY_PREFIX) && options.userId !== undefined) {
    headers['x-user-id'] = String(options.userId);
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    // fetch() only rejects on network-level failures — the "server is not running" case.
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
