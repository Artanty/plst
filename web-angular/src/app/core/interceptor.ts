import { HttpErrorResponse, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Session } from './session';

/**
 * Attaches x-user-id to every library call. A header, not a cookie, so there is no CSRF surface to
 * reason about while auth is still a dropdown — and the extension sends the identical header, so the
 * browser and the scanner share one server-side code path.
 */
export function userHeader(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  if (!req.url.startsWith('/api/library')) return next(req);
  return next(req.clone({ setHeaders: { 'x-user-id': String(inject(Session).userId()) } }));
}

/** Turns the backend's plain-text 4xx bodies into something worth putting in the UI. */
export function errorText(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'cannot reach the plst server — is `npm start` running in back/?';
    const body = (err.error as string | undefined) ?? '';
    return body.trim() || `${err.status} ${err.statusText}`;
  }
  return err instanceof Error ? err.message : String(err);
}
