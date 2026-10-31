import { YandexClient } from '../yandex/client.js';
import { logger } from '../lib/logger.js';

export interface PlayableSong {
  title: string;
  artists: string[];
}

/**
 * What the frontend needs to open a track: the music.yandex.ru page, plus WHAT was actually
 * matched. The matched title/artists travel back deliberately — a "listen" click that opens a
 * different song must be visibly wrong on the button, not silently wrong in the ears.
 */
export interface YandexRef {
  url: string;
  trackId: string;
  title: string;
  artists: string[];
}

/** Injected so tests never touch the network — the same pattern as MatchDeps in match.ts. */
export interface YandexDeps {
  searchTrack: (query: string) => Promise<any>;
}

export const defaultYandexDeps: YandexDeps = {
  searchTrack: (query) => new YandexClient().searchTrack(query),
};

export const yandexTrackUrl = (trackId: string): string => `https://music.yandex.ru/track/${trackId}`;

/** The search text: artists then title, the way a human would type it into Yandex Music. */
export function buildQuery(song: PlayableSong): string {
  return [...song.artists, song.title].filter(Boolean).join(' ');
}

/**
 * All candidates Yandex offers, in rank order: `best` first (its own verdict), then `hits`
 * (the older search shape), then `results` (the shape /search actually returns live as of
 * 2026-10-13). Only a candidate with a real id is usable.
 */
function candidates(result: any): any[] {
  const idOf = (t: any) => t?.realId ?? t?.id;
  const out: any[] = [];
  if (result?.best?.type === 'track' && idOf(result.best.data) != null) out.push(result.best.data);
  for (const t of [...(result?.tracks?.hits ?? []), ...(result?.tracks?.results ?? [])]) {
    if (idOf(t) != null) out.push(t);
  }
  return out;
}

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A candidate earns its place: 2 for a title that EQUALS the library song's (case/space
 * insensitive), 2 more for sharing an artist name. Live-checked 2026-10-13: without this,
 * "The Police — Roxanne" opened a Sweet Little Band cover, "Кино — Группа крови" a remix, and a
 * deliberately nonsense query returned someone else's song instead of nothing. Library artist
 * names come from the same Yandex DOM the search does, so equality is the honest test.
 */
function scoreCandidate(t: any, song: PlayableSong): number {
  const titleScore = norm(t?.title) === norm(song.title) ? 2 : 0;
  const candArtists = (t?.artists ?? []).map((a: any) => norm(a?.name));
  const artistHit = song.artists.some((a) => candArtists.includes(norm(a)));
  return titleScore + (artistHit ? 2 : 0);
}

/**
 * The best candidate by score — and null below the bar. A song with artists recorded must match
 * on BOTH title and artist (4); a song with no artists recorded settles for the title (2). Never
 * fall back to "the first thing Yandex said": a wrong track opened is worse than no track, the
 * same honesty rule as "uncertain is not a link".
 */
function pickTrack(result: any, song: PlayableSong): any | null {
  let best: any = null;
  let bestScore = 0;
  for (const t of candidates(result)) {
    const s = scoreCandidate(t, song);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore >= (song.artists.length ? 4 : 2) ? best : null;
}

/**
 * Resolve a song to its music.yandex.ru track page by text search. Two queries, best-first:
 * artists+title, then — if that yields nothing acceptable — the title alone. Live-verified
 * 2026-10-13: the artist text actually POLLUTES Yandex's ranking ("The Police Roxanne" buries
 * the real track under karaoke covers; plain "Roxanne" surfaces it on page 1), so the title-only
 * retry is not a nicety, it is the query that usually wins.
 *
 * Returns null on a miss — never a guessed URL: the same honesty rule as the YouTube export
 * ("uncertain is not a link"). Network/API errors propagate; the route turns them into a 502.
 */
export async function findTrackUrl(song: PlayableSong, deps: YandexDeps): Promise<YandexRef | null> {
  if (!buildQuery(song).trim()) return null;
  const attempts = song.title.trim() ? [buildQuery(song), song.title] : [buildQuery(song)];
  let track = null;
  for (const query of attempts) {
    track = pickTrack(await deps.searchTrack(query), song);
    if (track) break;
  }
  if (!track) {
    logger.log('yandex: no search match', { query: buildQuery(song) }, 'findTrackUrl');
    return null;
  }
  const rawId = track.realId ?? track.id;
  const artists = (track.artists ?? [])
    .map((a: any) => a?.name)
    .filter((n: any): n is string => Boolean(n));
  return {
    url: yandexTrackUrl(String(rawId)),
    trackId: String(rawId),
    title: String(track.title ?? ''),
    artists,
  };
}
