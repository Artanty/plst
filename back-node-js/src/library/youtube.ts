import { isConfident, type MatchableSong } from './match.js';

/**
 * Turning matched songs into the plain list of YouTube Music links this app has always produced.
 *
 * Two rules, both learned the hard way:
 *
 * 1. UNMATCHED SONGS ARE LISTED BY NAME. An export that silently drops the songs it could not match
 *    looks exactly like a complete export — you paste it into a playlist and discover the missing
 *    tracks later, with no way to tell which ones.
 * 2. AN UNCERTAIN MATCH IS NOT A LINK. The matcher can return a plausible-looking video it does not
 *    trust (a real run matched "Roxanne" to "Message In A Bottle — The Police" at 0.57). Those are
 *    reported separately, commented out, so pasting the list cannot quietly insert the wrong song.
 */

export interface ExportLink {
  songId: number;
  title: string;
  artists: string[];
  videoId: string;
  url: string;
  score: number | null;
}

export interface ExportUncertain {
  songId: number;
  title: string;
  artists: string[];
  videoId: string;
  url: string;
  score: number | null;
}

export interface ExportEntry {
  songId: number;
  title: string;
  artists: string[];
  matched: boolean;
  videoId: string | null;
  url: string | null;
  score: number | null;
}

export interface YoutubeExport {
  links: ExportLink[];
  /** Confident enough to paste. */
  matched: number;
  /** Matched, but the matcher does not trust the answer — listed, never linked. */
  uncertain: ExportUncertain[];
  /** Asked, and not in the catalog — the real "no match" answer. Excludes searchFailed rows. */
  unmatched: { songId: number; title: string; artists: string[] }[];
  /**
   * Songs whose match attempt NEVER REACHED YouTube (dead proxy, blocked network — stored as
   * match_status='search_failed'), kept DISJOINT from `unmatched` (which is a real "asked, not in
   * the catalog" answer) because the two call for different actions: fixing the network and
   * retrying can succeed for these, while a genuine not_found would just fail again.
   */
  searchFailed: { songId: number; title: string; artists: string[] }[];
  total: number;
  text: string;
}

export function ytUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${videoId}`;
}

export function buildYoutubeExport(songs: MatchableSong[]): YoutubeExport {
  const links: ExportLink[] = [];
  const uncertain: ExportUncertain[] = [];
  const unmatched: YoutubeExport['unmatched'] = [];
  const searchFailed: YoutubeExport['searchFailed'] = [];

  for (const song of songs) {
    if (!song.yt_video_id) {
      const entry = { songId: song.id, title: song.title, artists: song.artists };
      // The stored verdict decides which list: search_failed was never answered by YouTube, so it
      // gets its own block and a "fix the network and retry" message instead of "no match yet".
      if (song.match_status === 'search_failed') searchFailed.push(entry);
      else unmatched.push(entry);
    } else if (isConfident(song.match_score)) {
      links.push({
        songId: song.id,
        title: song.title,
        artists: song.artists,
        videoId: song.yt_video_id,
        url: ytUrl(song.yt_video_id),
        score: song.match_score,
      });
    } else {
      uncertain.push({
        songId: song.id,
        title: song.title,
        artists: song.artists,
        videoId: song.yt_video_id,
        url: ytUrl(song.yt_video_id),
        score: song.match_score,
      });
    }
  }

  return {
    links,
    matched: links.length,
    uncertain,
    unmatched,
    searchFailed,
    total: songs.length,
    text: renderText(songs.length, links, uncertain, unmatched, searchFailed),
  };
}

function credit(artists: string[]): string {
  return artists.length ? artists.join(', ') : 'unknown artist';
}

function renderText(
  total: number,
  links: ExportLink[],
  uncertain: ExportUncertain[],
  unmatched: YoutubeExport['unmatched'],
  searchFailed: YoutubeExport['searchFailed'],
): string {
  const lines: string[] = [];
  for (const link of links) lines.push(link.url);
  // Only separate the comment blocks from something. With no confident links the text would
  // otherwise start with a blank line, which is what you get when pasting into a playlist.
  const gap = () => {
    if (lines.length) lines.push('');
  };

  if (uncertain.length) {
    gap();
    lines.push(`# ${uncertain.length} uncertain match(es) — NOT pasted, check them by hand:`);
    for (const song of uncertain) {
      const score = song.score === null ? 'no score' : `score ${song.score.toFixed(2)}`;
      lines.push(`# - ${song.title} — ${credit(song.artists)} (${score}) -> ${song.url}`);
    }
  }

  // A different problem from "no match": these were never searched. The message names the action
  // (fix the network, match again) rather than leaving the reader to wonder why they're listed.
  if (searchFailed.length) {
    gap();
    lines.push(`# ${searchFailed.length} of ${total} song(s) were never searched — YouTube Music was unreachable:`);
    for (const song of searchFailed) lines.push(`# - ${song.title} — ${credit(song.artists)}`);
    lines.push('# Fix the connection (is YTM_PROXY running?) and press match again.');
  }

  if (unmatched.length) {
    gap();
    lines.push(`# ${unmatched.length} of ${total} songs have no YouTube Music match yet:`);
    for (const song of unmatched) lines.push(`# - ${song.title} — ${credit(song.artists)}`);
  }

  return lines.join('\n');
}
