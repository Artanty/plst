import crypto from 'node:crypto';
import { normalize } from '../matcher.js';

/**
 * Natural keys for the library, built on the SAME normalize() the matcher scores with.
 *
 * This is deliberate and load-bearing. Two subsystems decide "are these the same track?" — the
 * Yandex->YouTube matcher and the library's import dedup. If they normalized differently, a song
 * could be "new" on import and "known" to the matcher (or the reverse), and the library would fill
 * with near-duplicate rows. One normalizer means the two can never disagree. It is the same class
 * of bug that forced SCORE_VERSION into cacheKey.
 */
function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

/** Title key. Duration is deliberately excluded: it is the field a bad scrape gets wrong. */
export function songTitleKey(title: string): string {
  return sha1(`t|${normalize(title)}`);
}

/**
 * Song key. Artists are SORTED before joining so "B feat. A" and "A, B" are the same song, and the
 * list is set-joined with \u0000 which normalize() can never produce (it strips all non
 * letters/numbers/spaces), so ["ab","c"] and ["a","bc"] cannot collide.
 */
export function songDedupKey(title: string, artists: string[], durationS: number): string {
  const normArtists = [...new Set(artists.map((a) => normalize(a)).filter(Boolean))].sort();
  return sha1(`song|${normalize(title)}|${normArtists.join('\u0000')}|${durationS || 0}`);
}

export function artistKey(name: string): string {
  return sha1(`artist|${normalize(name)}`);
}

/**
 * Album key includes the year and the album's own artist when known. Keying an album on title
 * alone merges "Greatest Hits" by four different artists into one row, which then attributes every
 * song on it to whichever artist happened to be scanned first. When we do not know a year (the
 * extension scrapes the DOM, so we usually do not) the bare title is the best available key and a
 * merge is still better than no album at all.
 */
export function albumKey(title: string, artistId: number | null, year: number | null): string {
  return sha1(`album|${normalize(title)}|${artistId ?? ''}|${year ?? ''}`);
}
