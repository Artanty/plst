import { describe, expect, it } from 'vitest';
import { parseTrackJson } from '../src/pasteJson.js';

describe('parseTrackJson', () => {
  it('maps the browser extension shape onto TrackMeta', () => {
    const { tracks, skipped } = parseTrackJson(
      JSON.stringify([
        { title: 'Daze', artists: ['Poets Of The Fall'], album: 'Daze', durationS: 326 },
        { title: 'Body Talks', artists: ['The Struts', 'Kesha'], album: null, durationS: 177 },
      ]),
    );
    expect(skipped).toBe(0);
    expect(tracks[0]).toEqual({
      title: 'Daze',
      artists: ['Poets Of The Fall'],
      album: 'Daze',
      duration: 326,
      sourceId: null,
    });
    expect(tracks[1]!.artists).toEqual(['The Struts', 'Kesha']);
    expect(tracks[1]!.album).toBeNull();
  });

  it('accepts an object wrapper and a single artist string', () => {
    const { tracks } = parseTrackJson(
      JSON.stringify({ tracks: [{ title: 'Paradise', artists: 'Marc Martel', durationS: '251' }] }),
    );
    expect(tracks[0]!.artists).toEqual(['Marc Martel']);
    expect(tracks[0]!.duration).toBe(251);
  });

  it('skips rows with no title and reports the count', () => {
    const { tracks, skipped } = parseTrackJson(
      JSON.stringify([{ title: '  ' }, { artists: ['x'] }, { title: 'Real', artists: ['A'] }]),
    );
    expect(skipped).toBe(2);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.title).toBe('Real');
  });

  it('defaults missing artists and a bad duration instead of failing the run', () => {
    const { tracks } = parseTrackJson(JSON.stringify([{ title: 'No Meta', durationS: 'n/a' }]));
    expect(tracks[0]!.artists).toEqual(['Unknown']);
    expect(tracks[0]!.duration).toBe(0);
  });

  it('rejects input that cannot yield a track', () => {
    expect(() => parseTrackJson('not json')).toThrow(/not valid JSON/);
    expect(() => parseTrackJson('{"a":1}')).toThrow(/tracks/);
    expect(() => parseTrackJson('[]')).toThrow(/no usable rows/);
  });
});
