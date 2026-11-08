// YouTube matching and the link export. Everything here runs against a FAKE search: this machine
// cannot reach YouTube (connections silently drop — see back/AGENTS.md), so a test that reached for
// the real client would hang on retries and timeouts rather than assert anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { registerLibraryRoutes } from '../src/library/routes.js';
import type { LibraryStore } from '../src/library/store.js';
import type { Candidate } from '../src/model.js';
import { matchSong, matchSongs, type MatchDeps, type MatchableSong } from '../src/library/match.js';
import { buildYoutubeExport, ytUrl } from '../src/library/youtube.js';

const LIB = '/api/library';

const CANDIDATES: Candidate[] = [
  { videoId: 'aaaaaaaaaaa', title: 'Roxanne', artists: 'The Police', duration: 301 },
  { videoId: 'bbbbbbbbbbb', title: 'Roxanne (Live)', artists: 'The Police', duration: 320 },
  { videoId: 'ccccccccccc', title: 'De Do Do Do', artists: 'The Police', duration: 210 },
];

let searched: string[] = [];
const fakeDeps: MatchDeps = {
  searchSongs: async (query: string) => {
    searched.push(query);
    return CANDIDATES;
  },
};

function song(over: Partial<MatchableSong> = {}): MatchableSong {
  return {
    id: 1,
    title: 'Roxanne',
    artists: ['The Police'],
    album: 'Outlandos',
    duration: 300,
    yt_video_id: null,
    match_score: null,
    ...over,
  };
}

// ------------------------------------------------------------------ matcher

describe('library song matching', () => {
  it('finds the right video and reports the score', async () => {
    searched = [];
    const res = await matchSong(song(), fakeDeps);
    expect(res.status).toBe('matched');
    expect(res.videoId).toBe('aaaaaaaaaaa');
    expect(searched.length).toBeGreaterThan(0);
  });

  it('reports search_failed (with the cause) when the search itself dies — never not_found', async () => {
    // The live bug, 2026-10-19: YTM_PROXY pointed at a stopped local proxy, every query threw
    // ECONNREFUSED, and the UI said all 7 tracks were "not in the catalog". A dead search is not
    // an answer about the song — it must say so, and name the reason, or the reader goes looking
    // for a scoring bug instead of a network one.
    const res = await matchSong(song(), {
      searchSongs: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
      },
    });
    expect(res.status).toBe('search_failed');
    expect(res.videoId ?? null).toBeNull();
    expect(res.reason).toMatch(/ECONNREFUSED/);
  });

  it('still returns not_found when the search genuinely answers "nothing"', async () => {
    const res = await matchSong(song({ title: 'Zzzz No Such Song Anywhere' }), {
      searchSongs: async () => [],
    });
    expect(res.status).toBe('not_found');
    expect(res.videoId ?? null).toBeNull();
  });

  it('counts search_failed apart from not_found across a batch', async () => {
    // A batch where one song's search dies and another comes back empty: the two failures must
    // stay distinguishable, because "fix the network and retry" applies to only one of them.
    const res = await matchSongs([song({ id: 1, title: 'Crawling' }), song({ id: 2, title: 'Faint' })], {
      searchSongs: async (query) => {
        if (query.includes('Crawling')) throw new Error('connect ETIMEDOUT');
        return [];
      },
    });
    const byId = new Map(res.map((r) => [r.songId, r]));
    expect(byId.get(1)!.status).toBe('search_failed');
    expect(byId.get(1)!.reason).toMatch(/ETIMEDOUT/);
    expect(byId.get(2)!.status).toBe('not_found');
  });

  it('does not search again for a song that already has a video id', async () => {
    searched = [];
    const res = await matchSong(song({ yt_video_id: 'keepthisone' }), fakeDeps);
    expect(res.videoId).toBe('keepthisone');
    expect(searched).toEqual([]);
  });

  it('matches a batch and keeps every song, including the failures', async () => {
    const res = await matchSongs([song({ id: 1 }), song({ id: 2 }), song({ id: 3 })], fakeDeps);
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.songId > 0)).toBe(true);
    expect(res.every((r) => r.error === null)).toBe(true);
  });
});

// ------------------------------------------------------------------- export

describe('youtube link export', () => {
  it('renders one music.youtube.com link per confidently matched song', () => {
    const report = buildYoutubeExport([
      song({ id: 1, yt_video_id: 'aaaaaaaaaaa', match_score: 1 }),
      song({ id: 2, title: 'De Do Do Do', yt_video_id: 'ccccccccccc', match_score: 0.9 }),
    ]);
    expect(report.matched).toBe(2);
    expect(report.total).toBe(2);
    expect(report.links.map((l) => l.url)).toEqual([ytUrl('aaaaaaaaaaa'), ytUrl('ccccccccccc')]);
    expect(report.text).not.toContain('#');
  });

  it('does NOT paste an uncertain match as a link', () => {
    // Verified live: a Yandex "Roxanne" (with a wrong duration) was matched to
    // "Message In A Bottle - The Police" at 0.57. Exporting that as a link would put the wrong song
    // into someone's playlist while looking completely normal.
    const report = buildYoutubeExport([song({ id: 1, yt_video_id: 'wrongrap', match_score: 0.568 })]);
    expect(report.matched).toBe(0);
    expect(report.links).toEqual([]);
    expect(report.uncertain).toHaveLength(1);
    expect(report.uncertain[0].url).toBe(ytUrl('wrongrap'));
    // Listed and commented out, so the user can check it by hand.
    expect(report.text).toContain('#');
    expect(report.text).toContain('uncertain');
    expect(report.text.split('\n').every((l) => l.startsWith('#'))).toBe(true);
  });

  it('treats a stored match with no score as uncertain, not as gospel', () => {
    // match_score is null for a video id written by something other than this matcher.
    const report = buildYoutubeExport([song({ id: 1, yt_video_id: 'unknownscore', match_score: null })]);
    expect(report.links).toEqual([]);
    expect(report.uncertain).toHaveLength(1);
  });

  it('NAMES the unmatched songs instead of dropping them', async () => {
    // The whole point: a silently short export looks identical to a complete one.
    const report = buildYoutubeExport([
      song({ id: 1, yt_video_id: 'aaaaaaaaaaa', match_score: 1 }),
      song({ id: 2, title: 'Lost Song' }),
    ]);
    expect(report.matched).toBe(1);
    expect(report.total).toBe(2);
    expect(report.unmatched).toEqual([{ songId: 2, title: 'Lost Song', artists: ['The Police'] }]);
    expect(report.text).toContain('Lost Song');
    expect(report.text).toContain('1 of 2 songs');
  });

  it('lists search_failed songs SEPARATELY — never searched is not the same as not found', () => {
    // The export is the last place the difference can be told, so it must be told there: one list
    // says "retry after fixing the network", the other says "don't bother retrying".
    const report = buildYoutubeExport([
      song({ id: 1, title: 'Never Searched', match_status: 'search_failed' }),
      song({ id: 2, title: 'Genuinely Absent', match_status: 'not_found' }),
    ]);
    expect(report.searchFailed).toEqual([{ songId: 1, title: 'Never Searched', artists: ['The Police'] }]);
    expect(report.unmatched).toEqual([{ songId: 2, title: 'Genuinely Absent', artists: ['The Police'] }]);
    // Both are still NAMED — the text export never silently drops a song.
    expect(report.text).toContain('Never Searched');
    expect(report.text).toContain('Genuinely Absent');
    expect(report.text).toContain('never searched');
    expect(report.text).toContain('YTM_PROXY');
  });

  it('handles an empty selection without pretending it matched something', () => {
    const report = buildYoutubeExport([]);
    expect(report.matched).toBe(0);
    expect(report.total).toBe(0);
    expect(report.text).toBe('');
  });
});

// ------------------------------------------------------------------- routes

const ROW = (over: Partial<MatchableSong> & { id: number }) => song(over);

function stubStore(over: Record<string, unknown> = {}): LibraryStore {
  return {
    listUsers: async () => [{ id: 1, username: 'artyom', display_name: 'Artyom' }],
    getUser: async (id: number) => (id === 1 ? { id: 1, username: 'artyom', display_name: 'Artyom' } : null),
    matchableSongs: async (ids: number[]) => ids.map((id) => ROW({ id })),
    playlistSongsForLinks: async () => [
      ROW({ id: 1, yt_video_id: 'aaaaaaaaaaa', match_score: 1 }),
      ROW({ id: 2, title: 'Unmatched' }),
    ],
    setSongMatch: async () => undefined,
    getPlaylist: async (id: number) => ({ id, owner_id: 1, name: 'p', description: null, created_at: 0, updated_at: 0 }),
    listCollaborators: async () => [],
    ...over,
  } as unknown as LibraryStore;
}

function build(store: LibraryStore, deps: MatchDeps = fakeDeps) {
  const app = Fastify({ logger: false });
  registerLibraryRoutes(app, store, deps);
  return app;
}

describe('youtube endpoints', () => {
  it('matches a single song and returns the verdict', async () => {
    const saved: [number, string | null, number, string][] = [];
    const store = stubStore({
      setSongMatch: async (id: number, videoId: string | null, score: number, status: string) => {
        saved.push([id, videoId, score, status]);
      },
    });
    const app = build(store);
    const res = await app.inject({ method: 'POST', url: `${LIB}/songs/1/match`, headers: { 'x-user-id': '1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('matched');
    expect(res.json().videoId).toBe('aaaaaaaaaaa');
    // The verdict has to be persisted, otherwise the export that follows finds nothing — and the
    // STATUS travels with it, or 'search_failed' and 'not_found' become the same stored row.
    expect(saved[0][1]).toBe('aaaaaaaaaaa');
    expect(saved[0][3]).toBe('matched');
    await app.close();
  });

  it('exports a playlist as links plus an explicit unmatched list', async () => {
    const app = build(stubStore());
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/export/youtube?playlistId=5`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.matched).toBe(1);
    expect(body.unmatched).toHaveLength(1);
    expect(body.links[0].url).toContain('music.youtube.com/watch?v=');
    await app.close();
  });

  it('serves plain text when asked, which is what you paste into YouTube Music', async () => {
    const app = build(stubStore());
    const res = await app.inject({
      method: 'GET',
      url: `${LIB}/export/youtube?playlistId=5&format=text`,
      headers: { 'x-user-id': '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('https://music.youtube.com/watch?v=aaaaaaaaaaa');
    expect(res.body).toContain('Unmatched');
    await app.close();
  });

  it('refuses an export with no selection instead of returning everything', async () => {
    const app = build(stubStore());
    const res = await app.inject({ method: 'GET', url: `${LIB}/export/youtube`, headers: { 'x-user-id': '1' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('needs a user, like every other library route', async () => {
    const app = build(stubStore());
    const res = await app.inject({ method: 'GET', url: `${LIB}/export/youtube?playlistId=5` });
    // 400, not 401: there is no login yet, so a missing x-user-id is a malformed request.
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
