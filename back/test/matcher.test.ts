import { describe, expect, it } from 'vitest';
import { buildQueries, durationOk, matchTrack, normalize, transliterate } from '../src/matcher.js';
import type { Candidate, TrackMeta } from '../src/model.js';

function meta(title: string, artists: string[], duration: number): TrackMeta {
  return { title, artists, album: null, duration, sourceId: null };
}

function cand(videoId: string, title: string, artists: string, duration: number): Candidate {
  return { videoId, title, artists, duration };
}

describe('normalize', () => {
  it('strips brackets and noise', () => {
    expect(normalize('Bohemian Rhapsody (1991 Remaster)')).toBe('bohemian rhapsody');
    expect(normalize('Song — Official Video [HQ]')).toBe('song');
  });
});

describe('transliterate', () => {
  it('converts cyrillic to latin', () => {
    expect(transliterate('Звезда по имени Солнце')).toBe('zvezda po imeni solntse');
  });
  it('leaves latin text alone', () => {
    expect(transliterate('Plain Title')).toBe('Plain Title');
  });
});

describe('durationOk', () => {
  it('tolerates small differences', () => {
    expect(durationOk(100, 103, 5)).toBe(true);
  });
  it('rejects big differences', () => {
    expect(durationOk(100, 200, 5)).toBe(false);
  });
  it('returns null for missing data', () => {
    expect(durationOk(null, 100, 5)).toBeNull();
  });
});

describe('matchTrack', () => {
  it('accepts a good match', () => {
    const res = matchTrack(meta('Bohemian Rhapsody', ['Queen'], 355), [
      cand('vid1', 'Bohemian Rhapsody (Remaster 2011)', 'Queen', 355),
    ]);
    expect(res.status).toBe('matched');
    expect(res.videoId).toBe('vid1');
  });

  it('rejects wrong duration', () => {
    const res = matchTrack(meta('Hotel California', ['Eagles'], 390), [
      cand('vid2', 'Hotel California', 'Eagles', 120),
    ]);
    expect(['uncertain', 'not_found']).toContain(res.status);
  });

  it('prefers the studio cut over a same-title remix', () => {
    const track = meta("I Don't Feel Like Dancin'", ['Scissor Sisters'], 287);
    const remix = cand('bad', "I Don't Feel Like Dancin' (Teenage Bad Girl Remix)", 'Scissor Sisters', 284);
    const real = cand('good', "I Don't Feel Like Dancin'", 'Scissor Sisters', 289);
    const res = matchTrack(track, [remix, real]);
    expect(res.videoId).toBe('good');
    expect(res.status).toBe('matched');
  });

  it('does not penalize a remaster, which is the same recording', () => {
    const res = matchTrack(meta('Bohemian Rhapsody', ['Queen'], 355), [
      cand('v', 'Bohemian Rhapsody (Remastered 2011)', 'Queen', 355),
    ]);
    expect(res.score).toBe(1);
  });

  it('handles empty candidates', () => {
    const res = matchTrack(meta('Nothing', ['Nobody'], 200), []);
    expect(res.status).toBe('not_found');
  });
});

describe('buildQueries', () => {
  it('produces artist-first and transliterated variants', () => {
    const qs = buildQueries(meta('Звезда', ['Кино'], 200));
    expect(qs[0]).toBe('Кино Звезда');
    expect(qs.some((q) => q.includes('Kino') || q.includes('kino') || q.includes('Zvezda'))).toBe(true);
  });
});
