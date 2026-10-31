import { logger } from '../lib/logger.js';
import type { SongView } from './types.js';

/**
 * Genre detection is a provider interface with a no-op implementation, on purpose.
 *
 * The user asked for genre filtering "maybe there is some api somewhere". The honest answer is that
 * every real option costs something: Last.fm's track.getTopTags needs a free API key, MusicBrainz
 * is keyless but has patchy coverage and a 1 req/s budget, Spotify needs OAuth, and AcousticBrainz
 * is discontinued. So the SCHEMA and the FILTER are built now and the lookup is not: `genres` /
 * `song_genres` exist, search filters on them, and the UI shows them — they are simply empty until
 * an adapter is dropped in.
 *
 * The moment an adapter exists it implements this interface and nothing else changes: no route, no
 * component, no schema edit. That is the whole point of keeping the seam here.
 */

export interface GenreCandidate {
  name: string;
  /** 0..1 — how strongly this genre applies. Providers rarely agree on a scale, so normalize here. */
  weight: number;
}

export interface GenreLookupInput {
  songId: number;
  title: string;
  artists: string[];
  albumTitle: string | null;
  durationS: number;
}

export interface GenreProvider {
  readonly name: string;
  /** Returns true when it has something to say. A false means "leave the rows alone", never "clear them". */
  lookup(input: GenreLookupInput): Promise<GenreCandidate[]>;
}

/** The default. Says nothing, breaks nothing, costs nothing. */
export const NULL_GENRE_PROVIDER: GenreProvider = {
  name: 'none',
  async lookup() {
    return [];
  },
};

export function genreText(song: SongView): string {
  return song.genres.map((g) => g.name).join(', ');
}

export function describeProvider(provider: GenreProvider): string {
  if (provider === NULL_GENRE_PROVIDER) {
    logger.log('genre provider: none configured — genres stay empty until an adapter is added');
  }
  return provider.name;
}
