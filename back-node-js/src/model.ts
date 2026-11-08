export interface TrackMeta {
  title: string;
  artists: string[];
  album: string | null;
  duration: number; // seconds
  sourceId: string | null;
}


// 'search_failed' is deliberately NOT 'not_found': the first means "YouTube Music could not be
// asked at all" (blocked network, dead proxy — see YTM_PROXY), the second means "asked, and the
// song is not in the catalog". Conflating them reported a dead proxy as a missing Linkin Park
// track (live report 2026-10-19). Only 'not_found' is an answer about the song.
export type MatchStatus = 'matched' | 'uncertain' | 'not_found' | 'search_failed' | 'skipped_dup';

export interface MatchResult {
  status: MatchStatus;
  score: number;
  videoId?: string | null;
  ytTitle?: string | null;
  ytArtist?: string | null;
  ytDuration?: number | null;
  /** Why the search itself failed — only on 'search_failed'; names the cause, not just the fact. */
  reason?: string | null;
}

export interface Candidate {
  videoId: string;
  title: string;
  artists: string;
  duration: number | null;
}

export interface Collection {
  title: string;
  tracks: TrackMeta[];
}

export function artistStr(track: TrackMeta): string {
  return track.artists.join(', ');
}

export function matchUsable(res: MatchResult): boolean {
  return (res.status === 'matched' || res.status === 'uncertain') && !!res.videoId;
}
