import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, errorText, normalizeBase } from './http';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status: number, statusText: string): Response {
  return { ok: false, status, statusText, text: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch — the x-user-id header', () => {
  it('attaches the current user id to library calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch('/api/library/me', { userId: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/library/me');
    expect((init.headers as Record<string, string>)['x-user-id']).toBe('1');
  });

  it('follows the user that is passed, so a mid-session switch is visible on the next request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch('/api/library/playlists', { userId: 2 });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-user-id']).toBe('2');
  });

  it('leaves non-library requests alone — the plst pages must not get the header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch('/healthz', { userId: 7 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });

  it('sends no header at all when no user is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiFetch('/api/library/genres');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });

  it('serialises a body as JSON and marks the content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch('/api/library/playlists', { method: 'POST', body: { name: 'x' }, userId: 1 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('apiFetch — failures', () => {
  it('turns a network failure into status 0 instead of a raw TypeError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiFetch('/api/library/me', { userId: 1 })).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/api/library/me', { userId: 1 })).rejects.toMatchObject({ status: 0 });
  });

  it('carries the backend plain-text body on a 4xx', async () => {
    fetchMock.mockResolvedValue(textResponse('unknown song id: 9\n', 400, 'Bad Request'));
    await expect(
      apiFetch('/api/library/songs/9/match', { method: 'POST', userId: 1 }),
    ).rejects.toMatchObject({
      status: 400,
      body: 'unknown song id: 9\n',
    });
  });

  it('parses a 2xx JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ added: 3 }));
    await expect(
      apiFetch('/api/library/playlists/1/items', { method: 'POST', userId: 1 }),
    ).resolves.toEqual({
      added: 3,
    });
  });
});

describe('errorText', () => {
  it('says the server is unreachable instead of leaking "Failed to fetch"', () => {
    expect(errorText(new ApiError(0, '', 'Failed to fetch'))).toBe(
      'cannot reach the plst server — is `npm start` running in back/?',
    );
  });

  it("uses the backend's plain-text body when there is one", () => {
    expect(errorText(new ApiError(400, 'Bad Request', '  name already taken  '))).toBe(
      'name already taken',
    );
  });

  it('falls back to status and statusText when the body is empty', () => {
    expect(errorText(new ApiError(500, 'Internal Server Error', ''))).toBe(
      '500 Internal Server Error',
    );
    expect(errorText(new ApiError(500, 'Internal Server Error', '\n  '))).toBe(
      '500 Internal Server Error',
    );
  });

  it('passes plain errors and non-errors through', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('weird')).toBe('weird');
  });

  it('never shows an HTML body — surge answers missing paths with its own 404 page', () => {
    expect(errorText(new ApiError(404, 'Not Found', '<!DOCTYPE html>\n<html><body>Surge</body></html>'))).toBe(
      '404 Not Found: got an HTML page instead of JSON — is API_BASE (src/config.ts) pointing at the backend?',
    );
    expect(errorText(new ApiError(502, 'Bad Gateway', '  <html>cdn</html>  '))).toBe(
      '502 Bad Gateway: got an HTML page instead of JSON — is API_BASE (src/config.ts) pointing at the backend?',
    );
  });

  it('truncates a long body so a wall of text cannot fill the screen', () => {
    const long = 'x'.repeat(500);
    const shown = errorText(new ApiError(400, 'Bad Request', long));
    expect(shown).toBe(`${'x'.repeat(300)}…`);
  });
});

describe('normalizeBase', () => {
  it('keeps an absolute URL, stripping only trailing slashes', () => {
    expect(normalizeBase('https://api.example.com')).toBe('https://api.example.com');
    expect(normalizeBase('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBase('http://127.0.0.1:3218/')).toBe('http://127.0.0.1:3218');
  });

  it('repairs an http: value that lost its //', () => {
    expect(normalizeBase('http:localhost:3218')).toBe('http://localhost:3218');
  });

  it('gives a scheme-less value http://', () => {
    expect(normalizeBase('localhost:3218')).toBe('http://localhost:3218');
  });

  it("keeps '' as '' — same-origin is the dev default", () => {
    expect(normalizeBase('')).toBe('');
    expect(normalizeBase('   ')).toBe('');
  });
});
