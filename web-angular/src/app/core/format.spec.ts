import { describe, expect, it } from 'vitest';
import { artistCredit, artistsText, durationText, notificationText, plural, timeAgo } from './format';
import type { AppNotification, Song } from './models';

const song = (artists: Song['artists']): Song =>
  ({
    id: 1,
    dedup_key: 'k',
    title: 't',
    duration_s: 1,
    album_id: null,
    album_title: null,
    yt_video_id: null,
    match_score: null,
    matched_at: null,
    first_seen_at: 0,
    last_seen_at: 0,
    seen_count: 1,
    play_count: 0,
    artists,
    genres: [],
  }) as Song;

const note = (over: Partial<AppNotification>): AppNotification =>
  ({
    id: 1,
    user_id: 2,
    type: 'playlist_shared',
    actor_id: 1,
    actor_username: 'artyom',
    playlist_id: 1,
    playlist_name: 'Late night',
    import_id: null,
    is_read: false,
    created_at: 0,
    payload: null,
    ...over,
  }) as AppNotification;

describe('artistCredit', () => {
  it('keeps a plain artist list as is', () => {
    expect(artistsText(song([{ id: 1, name: 'The Police', role: 'main' }]))).toBe('The Police');
  });

  it('marks featured artists, so "A, B" is not read as two unrelated names', () => {
    expect(
      artistCredit(
        song([
          { id: 1, name: 'Kool G Rap', role: 'main' },
          { id: 2, name: 'DJ Jazzy Jeff', role: 'feat' },
        ]),
      ),
    ).toBe('Kool G Rap feat. DJ Jazzy Jeff');
  });

  it('falls back to every artist when the roles are all missing', () => {
    const s = song([
      { id: 1, name: 'A', role: 'producer' },
      { id: 2, name: 'B', role: 'producer' },
    ]);
    expect(artistCredit(s)).toBe('A, B');
  });
});

describe('durationText', () => {
  it('pads seconds and never prints NaN for a missing duration', () => {
    expect(durationText(300)).toBe('5:00');
    expect(durationText(198)).toBe('3:18');
    expect(durationText(5)).toBe('0:05');
  });

  it('rounds, so 59.6s is 1:00 and not 0:60', () => {
    expect(durationText(59.6)).toBe('1:00');
  });

  it('shows a dash for null, 0 and nonsense — a song never has a 0s duration worth printing', () => {
    expect(durationText(null)).toBe('—');
    expect(durationText(undefined)).toBe('—');
    expect(durationText(0)).toBe('—');
    expect(durationText(-3)).toBe('—');
  });
});

describe('timeAgo', () => {
  const now = Date.now() / 1000;
  it('picks the biggest sensible unit', () => {
    expect(timeAgo(now - 5)).toBe('just now');
    expect(timeAgo(now - 90)).toBe('1m ago');
    expect(timeAgo(now - 7200)).toBe('2h ago');
    expect(timeAgo(now - 86400 * 3)).toBe('3d ago');
  });

  it('never goes negative on clock skew', () => {
    expect(timeAgo(now + 60)).toBe('just now');
  });
});

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'track')).toBe('1 track');
    expect(plural(2, 'track')).toBe('2 tracks');
    expect(plural(0, 'import')).toBe('0 imports');
    expect(plural(3, 'match', 'matches')).toBe('3 matches');
  });
});

describe('notificationText', () => {
  it('names the actor and the playlist', () => {
    expect(notificationText(note({}))).toBe('artyom shared “Late night” with you');
  });

  it('says "someone" when there is no actor', () => {
    expect(notificationText(note({ actor_username: null, type: 'playlist_edited' }))).toBe(
      'someone edited “Late night”',
    );
  });

  it('falls back when the playlist name is gone', () => {
    expect(notificationText(note({ playlist_name: null }))).toBe('artyom shared a playlist with you');
  });

  it('reads the new name out of the payload, and survives a missing one', () => {
    expect(
      notificationText(note({ type: 'playlist_renamed', payload: { name: 'Night+2' } as never })),
    ).toBe('artyom renamed “Late night” to “Night+2”');
    expect(notificationText(note({ type: 'playlist_renamed', payload: null }))).toBe(
      'artyom renamed “Late night” to “(renamed)”',
    );
  });

  it('does not throw on a notification type it has never seen', () => {
    expect(notificationText(note({ type: 'something_new' as never }))).toBe('artyom did something in “Late night”');
  });
});
