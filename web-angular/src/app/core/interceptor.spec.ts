import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userHeader } from './interceptor';
import { Session } from './session';

describe('userHeader interceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let session: Session;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([userHeader])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    session = TestBed.inject(Session);
  });

  afterEach(() => {
    backend.verify();
    localStorage.clear();
  });

  it('attaches the stored user id to library calls', () => {
    http.get('/api/library/me').subscribe();
    const req = backend.expectOne('/api/library/me');
    expect(req.request.headers.get('x-user-id')).toBe('1');
    req.flush({});
  });

  it('follows the session when the user is switched mid-session', () => {
    session.switchTo(2);
    http.get('/api/library/playlists').subscribe();
    const req = backend.expectOne('/api/library/playlists');
    expect(req.request.headers.get('x-user-id')).toBe('2');
    req.flush({});
  });

  it('leaves non-library requests alone — the plst pages must not get the header', () => {
    http.get('/healthz').subscribe();
    const req = backend.expectOne('/healthz');
    expect(req.request.headers.has('x-user-id')).toBe(false);
    req.flush({});
  });
});
