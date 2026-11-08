import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { logger } from '../lib/logger.js';
import { settings } from '../config.js';
import type { Collection, TrackMeta } from '../model.js';
import type { YandexTarget } from '../url.js';

const BASE = 'https://api.music.yandex.ru';
const DEVICE_ID = '7eaa39f9-c5b1-4181-a712-7c3e36670319';

interface YandexResponse {
  result?: any;
  error?: { name?: string; message?: string };
}

export class YandexClient {
  private token: string | null;
  private dispatcher: ProxyAgent | undefined;

  constructor(token: string | null = settings.yandexToken, proxy: string | null = settings.yandexProxy) {
    this.token = token;
    if (proxy) this.dispatcher = new ProxyAgent(proxy);
  }

  private headers(anonymous = false): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': 'Yandex-Music-API',
      'Accept-Language': 'ru',
      'X-Yandex-Music-Device-Id': DEVICE_ID,
      'X-Yandex-Music-Device-UUID': DEVICE_ID,
    };
    // OAuth turns PUBLIC share-token playlists 200→403 (Yandex validates against the owning account).
    // MarshalX contract: share links resolve ANONYMOUSLY — so playlistShare requests send no Authorization.
    if (!anonymous && this.token) h['Authorization'] = `OAuth ${this.token}`;
    return h;
  }

  private async request(path: string, params?: Record<string, string>, anonymous = false): Promise<any> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await undiciFetch(url.toString(), {
      headers: this.headers(anonymous),
      dispatcher: this.dispatcher,
    } as any);
    const body = (await res.json().catch(() => null)) as YandexResponse | null;
    if (body?.error) {
      // `error` is an object on Yandex's own API errors but a bare STRING on the OAuth
      // front (a dead token answers `{"error":"Unauthorized"}`) — the string case used to
      // print "[undefined]: undefined" and hide the actual cause.
      const e = body.error as any;
      const desc = typeof e === 'object' ? `[${e?.name}]: ${e?.message}` : String(e);
      const err = new Error(`Yandex API error ${desc}`);
      logger.error('yandex: API error', err, 'yandexClient.request');
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Yandex API HTTP ${res.status} for ${path}`);
      logger.error('yandex: HTTP error', err, 'yandexClient.request');
      throw err;
    }
    logger.log('yandex: ok', { path, status: res.status });
    return body?.result ?? null;
  }

  playlist(kind: string, user: string): Promise<any> {
    return this.request(`/users/${encodeURIComponent(user)}/playlists/${encodeURIComponent(kind)}`);
  }

  // share links: https://music.yandex.ru/playlists/lk.<token> resolve to the underlying playlist
  // (full track list included) via /playlist/<token>. Decision 2026-09-20: send OAuth — the
  // attached YANDEX_TOKEN must be the account that OWNS the playlist (album-with-token = live 200;
  // anonymous undici is flagged HTTP 403 by Yandex, so anonymity is both undocumented here and broken).
  playlistShare(token: string): Promise<any> {
    return this.request(`/playlist/${encodeURIComponent(token)}`);
  }

  likesTracks(user?: string | null): Promise<any> {
    return this.request(`/users/${encodeURIComponent(user || 'me')}/likes/tracks`);
  }

  async tracks(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const result = await this.request('/tracks', { trackIds: batch.join(','), with: 'pos' });
      out.push(...(result ?? []));
    }
    return out;
  }

  /**
   * Text search, used by the library's "listen" button. Two live-verified facts (2026-10-13):
   * 2026-10-13): `page` is mandatory (without it: HTTP 400 "validate: page: Parameter value is
   * not set"), and the request must go out ANONYMOUSLY — search answers a bare
   * `User-Agent: Yandex-Music-API` request with 200, while attaching the stored OAuth token
   * gets a 401 (the token can expire, and an expired token must not take the whole lookup down).
   */
  searchTrack(text: string): Promise<any> {
    return this.request('/search', { type: 'track', text, page: '1' }, true);
  }

  async albumWithTracks(albumId: string): Promise<any> {
    const path = `/albums/${encodeURIComponent(albumId)}`;
    try {
      return await this.request(`${path}/with-tracks`);
    } catch (err) {
      // Decision 2026-09-21 (user picked option 1): Yandex WAF 403s /with-tracks even for the
      // owning token — album positive control = live 403 = `failed` (reproduced via our own
      // client; see DECISIONS). Fall back to WAF-safe plain /albums/{id} + batched /tracks.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('HTTP 403')) throw err; // only the WAF-403 is the fallback trigger
      const album = await this.request(path);
      if (!album) return null;
      const entries = (album.volumes ?? []).flat() ?? [];
      const needsFetch = entries.some((t: any) => !t || (typeof t === 'object' && !t.title));
      if (needsFetch && entries.length) {
        const ids = entries.map((t: any) => String(t?.id ?? t));
        const full = (await this.tracks(ids)).filter(Boolean);
        let fi = 0;
        album.volumes = (album.volumes ?? []).map((v: any[]) =>
          (v ?? []).map((t: any) => (t && typeof t === 'object' && t.title ? t : full[fi++])).filter(Boolean),
        );
      }
      return album;
    }
  }
}

export function trackMeta(raw: any): TrackMeta | null {
  if (!raw || raw.error) return null;
  const title = raw.title ?? raw.track?.title;
  if (!title) return null;
  const durationMs = raw.durationMs ?? raw.track?.durationMs ?? raw.length ?? 0;
  const artists = (raw.artists ?? raw.track?.artists ?? [])
    .map((a: any) => a.name)
    .filter((n: any): n is string => Boolean(n));
  const album = raw.albums?.[0]?.title ?? raw.albums?.[0]?.name ?? raw.albums?.[0]?.version ?? null;
  return {
    title,
    artists: artists.length ? artists : ['Unknown'],
    album,
    duration: Math.round(durationMs / 1000),
    sourceId: String(raw.realId ?? raw.id ?? ''),
  };
}

export function trackMetaFromId(rawId: any): string | null {
  const id = rawId?.trackId ?? rawId?.id ?? rawId;
  if (id === undefined || id === null) return null;
  return String(id);
}

function expandTracks(rawTracks: any[], client: YandexClient): Promise<TrackMeta[]> {
  const metas: (TrackMeta | null)[] = rawTracks.map(trackMeta);
  const missingIds = rawTracks
    .map((t, i) => (metas[i] ? null : trackMetaFromId(t)))
    .filter((x): x is string => Boolean(x));
  if (!missingIds.length) {
    return Promise.resolve(metas.filter((m): m is TrackMeta => Boolean(m)));
  }
  return client.tracks(missingIds).then((full) => {
    for (const t of full) {
      const m = trackMeta(t);
      if (m) metas[rawTracks.findIndex((raw) => trackMetaFromId(raw) === m.sourceId)] = m;
    }
    return metas.filter((m): m is TrackMeta => Boolean(m));
  });
}

export async function fetchCollections(target: YandexTarget, client: YandexClient): Promise<Collection[]> {
  if (target.mode === 'playlist') {
    const pl = target.shareToken
      ? await client.playlistShare(target.shareToken)
      : await client.playlist(target.kind!, target.user!);
    if (!pl) throw new Error('playlist not found or not accessible');
    const metas = await expandTracks(pl.tracks ?? [], client);
    return [{ title: pl.title ?? 'Playlist', tracks: metas }];
  }

  if (target.mode === 'liked') {
    const data = await client.likesTracks(target.user);
    const ids = (data?.tracks ?? []).map(trackMetaFromId).filter((x: any): x is string => Boolean(x));
    const full = await client.tracks(ids);
    const metas = full.map(trackMeta).filter((m): m is TrackMeta => Boolean(m));
    return [{ title: 'Liked from Yandex Music', tracks: metas }];
  }

  if (target.mode === 'album') {
    const album = await client.albumWithTracks(target.albumId!);
    if (!album) throw new Error('album not found');
    return [{ title: album.title ?? "Album", tracks: albumTracks(album) }];
  }

  throw new Error(`unknown mode: ${target.mode}`);
}

function albumTracks(album: any): TrackMeta[] {
  const metas: TrackMeta[] = [];
  for (const volume of album.volumes ?? []) {
    for (const t of volume) {
      const m = trackMeta(t);
      if (m) metas.push(m);
    }
  }
  return metas;
}
