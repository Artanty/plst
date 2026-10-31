import { describe, expect, it } from 'vitest';
import { fromForm, parseUrl } from '../src/url.js';

describe('parseUrl', () => {
  it('parses playlist URLs', () => {
    const t = parseUrl('https://music.yandex.ru/users/someuser/playlists/12345');
    expect(t.mode).toBe('playlist');
    expect(t.user).toBe('someuser');
    expect(t.kind).toBe('12345');
  });

  it('parses liked URLs', () => {
    const t = parseUrl('https://music.yandex.ru/users/someuser/playlists/liked');
    expect(t.mode).toBe('liked');
    expect(t.user).toBe('someuser');
  });

  it('parses album URLs', () => {
    const t = parseUrl('https://music.yandex.ru/album/9876543/track/123');
    expect(t.mode).toBe('album');
    expect(t.albumId).toBe('9876543');
  });

  it('supports other regional domains', () => {
    const t = parseUrl('https://music.yandex.uz/users/x/playlists/7');
    expect(t.mode).toBe('playlist');
    expect(t.kind).toBe('7');
  });

  it('parses shared playlist URLs (lk.<token>)', () => {
    const t = parseUrl(
      'https://music.yandex.ru/playlists/lk.7c39432a-7d1d-47b3-8e81-9af76cad4e65?utm_source=web&utm_medium=copy_link',
    );
    expect(t.mode).toBe('playlist');
    expect(t.shareToken).toBe('lk.7c39432a-7d1d-47b3-8e81-9af76cad4e65');
    expect(t.user).toBeNull();
  });

  it('rejects unsupported URLs', () => {
    expect(() => parseUrl('https://example.com/x')).toThrow(/unsupported/);
  });
});

describe('fromForm', () => {
  it('extracts username from pasted URL in user modes', () => {
    const t = fromForm('liked', 'https://music.yandex.ru/users/vasya/playlists/liked');
    expect(t.mode).toBe('liked');
    expect(t.user).toBe('vasya');
  });

  it('routes pasted track JSON without trying to parse a Yandex URL', () => {
    const t = fromForm('json', '[{"title":"Daze","artists":["Poets Of The Fall"],"durationS":326}]');
    expect(t.mode).toBe('json');
  });

  it('rejects unknown modes', () => {
    expect(() => fromForm('nope' as never, 'x')).toThrow(/unknown mode/);
  });
});
