export type Mode = 'playlist' | 'liked' | 'album' | 'json';

import { logger } from './lib/logger.js';


export interface YandexTarget {
  mode: Mode;
  user?: string | null;
  kind?: string | null;
  albumId?: string | null;
  shareToken?: string | null;
  url?: string | null;
}

const PLAYLIST_RE =
  /(?:music\.yandex\.(?:ru|by|kz|am|az|ge|com|md|tm|kg|uz)\/)users\/(?<user>[^/]+)\/playlists\/(?<kind>[^/?#&]+)/i;
// share links  https://music.yandex.ru/playlists/{token}
// token is either the legacy "lk.<uuid>" form or (2025+ web copy-link) a bare 36-char uuid; no user prefix in either.
const SHARE_RE = /(?:music\.yandex\.(?:ru|by|kz|am|az|ge|com|md|tm|kg|uz)\/)playlists\/((?:lk\.)?[0-9a-fA-F-]{36})/i;
const ALBUM_RE = /(?:music\.yandex\.(?:ru|by|kz|am|az|ge|com|md|tm|kg|uz)\/)album\/(?<album>\d+)/i;

export function parseUrl(url: string): YandexTarget {
  url = url.trim();
  const album = ALBUM_RE.exec(url);
  if (album?.groups) {
    logger.log('url: album', { albumId: album.groups.album, url });
    return { mode: 'album', albumId: album.groups.album, url };
  }
  const share = SHARE_RE.exec(url);
  if (share?.[1]) {
    logger.log('url: share playlist', { shareToken: share[1], url });
  return { mode: 'playlist', user: null, shareToken: share[1], url };
  }
  const m = PLAYLIST_RE.exec(url);
  if (m?.groups) {
    const user = m.groups.user;
    const kind = m.groups.kind;
    if (kind.toLowerCase() === 'liked') {
      logger.log('url: liked', { user, url });
      return { mode: 'liked', user, url };
    }
    return { mode: 'playlist', user, kind, url };
  }
  throw new Error(`unsupported Yandex Music URL: ${JSON.stringify(url)}`);
}

export function fromForm(mode: string, source: string): YandexTarget {
  source = source.trim();
  // Track JSON from the browser extension: there is no Yandex URL to parse. The body is validated by
  // the caller via parseTrackJson, which is the only thing that can actually reject it.
  if (mode === 'json') {
    return { mode: 'json' };
  }
  const bareShare = /^lk\.[0-9a-fA-F-]{36}$/.exec(source)
    || /\/(lk\.[0-9a-fA-F-]{36})[\/?#]?/.exec(source.split('music.yandex')[1] ?? '');
  if (bareShare?.[1] || /^lk\.[0-9a-fA-F-]{36}$/.test(source)) {
    const token = bareShare?.[1] ?? source;
    logger.log('url: share token routed to playlist', { shareToken: token, requestedMode: mode });
    return { mode: 'playlist', user: null, shareToken: token, url: source };
  }
  if (mode === 'playlist') {
    const t = parseUrl(source);
    if (t.mode !== 'playlist') {
      throw new Error('expected a playlist URL like music.yandex.ru/users/<user>/playlists/<kind>');
    }
    return t;
  }
  if (mode === 'album') {
    const t = parseUrl(source);
    if (t.mode !== 'album') {
      throw new Error('expected an album URL like music.yandex.ru/album/<id>');
    }
    return t;
  }
  if (mode === 'liked') {
    let user = source;
    if (user.includes('/')) {
      const m = /\/users\/([^/?#&]+)/.exec(user);
      user = m ? m[1] : user.replace(/\/+$/, '').split('/').pop() ?? '';
    }
    if (!user) {
      throw new Error('Yandex user name is required');
    }
    return { mode, user };
  }
  throw new Error(`unknown mode: ${mode}`);
}
