// "listen" — resolving a library song to its music.yandex.ru page. Everything runs against a FAKE
// search dep, the same way library-youtube.test.ts fakes YouTube: the lookup must be testable
// without Yandex being reachable, and a route test that reached for the real client would hang on
// the network instead of asserting anything.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerLibraryRoutes } from '../src/library/routes.js';
import type { LibraryStore } from '../src/library/store.js';
import type { MatchableSong } from '../src/library/match.js';
import {
  buildQuery,
  findTrackUrl,
  yandexTrackUrl,
  type YandexDeps,
} from '../src/library/yandex.js';

const LIB = '/api/library';

// The real /search shape: `best` is Yandex's own verdict, `tracks.hits` the fallback list.
const SEARCH_BEST = {
  result: {
    best: { type: 'track', data: { id: 42, title: 'Roxanne', artists: [{ name: 'The Police' }] } },
    tracks: {
      total: 2,
      hits: [
        { id: 42, title: 'Roxanne', artists: [{ name: 'The Police' }] },
        { id: 43, title: 'Roxanne (Live)', artists: [{ name: 'The Police' }] },
      ],
    },
  },
};

const SONG = { title: 'Roxanne', artists: ['The Police'] };

// ------------------------------------------------------------------- lookup

describe('findTrackUrl', () => {
  it('prefers Yandex’s own `best` verdict and returns a track page URL', async () => {
    const ref = await findTrackUrl(SONG, { searchTrack: async () => SEARCH_BEST.result });
    expect(ref).not.toBeNull();
    expect(ref!.url).toBe('https://music.yandex.ru/track/42');
    expect(ref!.trackId).toBe('42');
    // What was matched travels back, so a wrong hit is visible on the button.
    expect(ref!.title).toBe('Roxanne');
    expect(ref!.artists).toEqual(['The Police']);
  });

  it('falls back to the first hit with an id when there is no `best`', async () => {
    const noBest = { tracks: SEARCH_BEST.result.tracks };
    const ref = await findTrackUrl(SONG, { searchTrack: async () => noBest });
    expect(ref!.trackId).toBe('42');
  });

  it('reads the live `results` shape too — that is what /search actually returns', async () => {
    // Verified live 2026-10-13: no `best`, no `hits` — just { tracks: { results: [...] } }.
    const live = { tracks: { total: 2, results: SEARCH_BEST.result.tracks.hits } };
    const ref = await findTrackUrl(SONG, { searchTrack: async () => live });
    expect(ref!.trackId).toBe('42');
  });

  it('prefers the candidate that matches title AND artist — not a cover ranked above it', async () => {
    // Verified live: the top hit for "The Police — Roxanne" is "Roxanne In the Style of the
    // Police", a karaoke cover; the real track sits further down the same list.
    const withCoverFirst = {
      tracks: {
        results: [
          { id: 6065484, title: 'Roxanne In the Style of the Police', artists: [{ name: 'Karaoke Universe' }] },
          { id: 77, title: 'Roxanne', artists: [{ name: 'Sweet Little Band' }] },
          { id: 42, title: 'Roxanne', artists: [{ name: 'The Police' }] },
        ],
      },
    };
    const ref = await findTrackUrl(SONG, { searchTrack: async () => withCoverFirst });
    expect(ref!.trackId).toBe('42');
    // Case/space-insensitive equality: a casing drift must not lose the real track.
    const casing = {
      tracks: {
        results: [
          { id: 2, title: 'Roxanne (Remix)', artists: [{ name: 'Karaoke Band' }] },
          { id: 1, title: '  roxanne ', artists: [{ name: 'The Police' }] },
        ],
      },
    };
    expect((await findTrackUrl(SONG, { searchTrack: async () => casing }))!.trackId).toBe('1');
  });

  it('returns null rather than someone else’s song when nothing truly matches', async () => {
    // Verified live: a deliberately nonsense query still returned "Nobody Knows — Umeg". Opening
    // that would be a confidently wrong link — exactly what this endpoint must never produce.
    const wrong = {
      tracks: {
        results: [
          { id: 82197151, title: 'Nobody Knows', artists: [{ name: 'Umeg' }] },
          { id: 5, title: 'Группа крови', artists: [{ name: 'Паша Кореец' }] },
        ],
      },
    };
    expect(
      await findTrackUrl({ title: 'Definitely Not A Song Ever', artists: ['Nobody'] }, {
        searchTrack: async () => wrong,
      }),
    ).toBeNull();
  });

  it('retries with the title alone when artists+title finds nothing acceptable', async () => {
    // Live-verified: "The Police Roxanne" buries the real track under karaoke; plain "Roxanne"
    // surfaces it. The second query is what makes listen actually work.
    const queries: string[] = [];
    const karaokeOnly = {
      tracks: { results: [{ id: 1, title: 'Roxanne', artists: [{ name: 'Sweet Little Band' }] }] },
    };
    const real = {
      tracks: { results: [{ id: 6877483, title: 'Roxanne', artists: [{ name: 'The Police' }] }] },
    };
    const ref = await findTrackUrl(SONG, {
      searchTrack: async (q) => {
        queries.push(q);
        return queries.length === 1 ? karaokeOnly : real;
      },
    });
    expect(queries).toEqual(['The Police Roxanne', 'Roxanne']);
    expect(ref!.trackId).toBe('6877483');
  });

  it('does not search twice when the first query already found the song', async () => {
    let calls = 0;
    await findTrackUrl(SONG, {
      searchTrack: async () => {
        calls++;
        return SEARCH_BEST.result;
      },
    });
    expect(calls).toBe(1);
  });

  it('returns null on a miss — never a guessed URL', async () => {
    for (const empty of [{}, { tracks: { hits: [] } }, null, undefined]) {
      const ref = await findTrackUrl(SONG, { searchTrack: async () => empty });
      expect(ref).toBeNull();
    }
  });

  it('returns null rather than searching when the song has nothing to search with', async () => {
    let calls = 0;
    const deps: YandexDeps = { searchTrack: async () => { calls++; return SEARCH_BEST; } };
    expect(await findTrackUrl({ title: '', artists: [] }, deps)).toBeNull();
    expect(calls).toBe(0);
  });

  it('propagates a Yandex failure (the route turns it into a 502)', async () => {
    await expect(
      findTrackUrl(SONG, {
        searchTrack: async () => {
          throw new Error('Yandex API HTTP 403');
        },
      }),
    ).rejects.toThrow('HTTP 403');
  });

  it('builds the query as artists-then-title, the way a human types it', () => {
    expect(buildQuery(SONG)).toBe('The Police Roxanne');
    expect(buildQuery({ title: 'Solo', artists: [] })).toBe('Solo');
  });

  it('accepts a track id only as realId-first, like the rest of the client code', async () => {
    const ref = await findTrackUrl(SONG, {
      searchTrack: async () => ({
        best: {
          type: 'track',
          data: { realId: 'abc', id: 99, title: 'Roxanne', artists: [{ name: 'The Police' }] },
        },
      }),
    });
    expect(ref!.trackId).toBe('abc');
    expect(ref!.url).toBe(yandexTrackUrl('abc'));
  });
});

// -------------------------------------------------------------------- route

const ROW = (over: Partial<MatchableSong> & { id: number }): MatchableSong => ({
  title: 'Roxanne',
  artists: ['The Police'],
  album: 'Outlandos',
  duration: 300,
  yt_video_id: null,
  match_score: null,
  ...over,
});

function stubStore(over: Record<string, unknown> = {}): LibraryStore {
  return {
    getUser: async (id: number) => (id === 1 ? { id: 1, username: 'artyom', display_name: 'Artyom' } : null),
    matchableSongs: async (ids: number[]) => ids.map((id) => ROW({ id })),
    ...over,
  } as unknown as LibraryStore;
}

function build(store: LibraryStore, yandexDeps: YandexDeps) {
  const app = Fastify({ logger: false });
  // matchDeps is irrelevant here, but the parameter is positional — pass a harmless fake.
  registerLibraryRoutes(app, store, { searchSongs: async () => [] }, yandexDeps);
  return app;
}

const okDeps: YandexDeps = { searchTrack: async () => SEARCH_BEST.result };

describe('GET /songs/:id/yandex', () => {
  it('returns the music.yandex.ru page for a known song', async () => {
    const app = build(stubStore(), okDeps);
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/songs/1/yandex`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBe('https://music.yandex.ru/track/42');
    expect(body.songId).toBe(1);
    await app.close();
  });

  it('404s on a song the library does not have', async () => {
    const app = build(stubStore({ matchableSongs: async () => [] }), okDeps);
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/songs/99/yandex`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('song not found');
    await app.close();
  });

  it('404s with the song’s name when nothing matches — no guessed link', async () => {
    const app = build(stubStore(), { searchTrack: async () => ({ tracks: { hits: [] } }) });
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/songs/1/yandex`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Roxanne');
    await app.close();
  });

  it('502s and names the cause when Yandex itself fails', async () => {
    const app = build(stubStore(), {
      searchTrack: async () => {
        throw new Error('Yandex API HTTP 403');
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/songs/1/yandex`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('403');
    await app.close();
  });

  it('still requires a caller, like every other library route', async () => {
    const app = build(stubStore(), okDeps);
    const res = await app.inject({ method: 'GET', url: `${LIB}/songs/1/yandex` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
