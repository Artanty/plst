"""Yandex Music API client — port of back-node-js/src/yandex/client.ts.

requests stands in for undici; the proxy (YANDEX_PROXY) goes on the injected session, endpoints,
headers (device-id etc.), the ANONYMOUS search_track and the WAF-403 album fallback are kept 1:1.
"""
import json
import urllib.parse

import requests

from config import settings
from lib.logger import logger

BASE = "https://api.music.yandex.ru"
DEVICE_ID = "7eaa39f9-c5b1-4181-a712-7c3e36670319"


class YandexTarget(dict):
    """Parsed collection target ({mode, user, kind, shareToken, albumId}) — node's YandexTarget.

    Kept as a plain dict with camelCase keys so callers can hand over exactly what the node
    url.ts parser produced.
    """


class YandexClient:
    def __init__(self, token=None, proxy=None, session=None):
        """`session` is injectable so tests never touch the network."""
        self.token = settings.yandex_token if token is None else token
        proxy = settings.yandex_proxy if proxy is None else proxy
        self.session = session if session is not None else requests.Session()
        if proxy:
            self.session.proxies.update({"http": proxy, "https": proxy})

    def _headers(self, anonymous=False):
        h = {
            "User-Agent": "Yandex-Music-API",
            "Accept-Language": "ru",
            "X-Yandex-Music-Device-Id": DEVICE_ID,
            "X-Yandex-Music-Device-UUID": DEVICE_ID,
        }
        # OAuth turns PUBLIC share-token playlists 200→403 (Yandex validates against the owning
        # account). MarshalX contract: share links resolve ANONYMOUSLY — so playlistShare requests
        # send no Authorization. (Decision 2026-09-20 in the node build: send OAuth — the attached
        # YANDEX_TOKEN must OWN the playlist.)
        if not anonymous and self.token:
            h["Authorization"] = f"OAuth {self.token}"
        return h

    def request(self, path, params=None, anonymous=False):
        url = BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        res = self.session.get(url, headers=self._headers(anonymous))
        try:
            body = res.json()
        except (ValueError, json.JSONDecodeError):
            body = None
        if body and body.get("error"):
            # `error` is an object on Yandex's own API errors but a bare STRING on the OAuth
            # front (a dead token answers `{"error":"Unauthorized"}`) — the string case used to
            # print "[undefined]: undefined" and hide the actual cause.
            e = body["error"]
            desc = f"[{e.get('name')}]: {e.get('message')}" if isinstance(e, dict) else str(e)
            err = Exception(f"Yandex API error {desc}")
            logger.error("yandex: API error", err, "yandexClient.request")
            raise err
        if not res.ok:
            err = Exception(f"Yandex API HTTP {res.status_code} for {path}")
            logger.error("yandex: HTTP error", err, "yandexClient.request")
            raise err
        logger.log("yandex: ok", {"path": path, "status": res.status_code})
        return body.get("result") if body else None

    def playlist(self, kind, user):
        return self.request(f"/users/{urllib.parse.quote(str(user), safe='')}/playlists/{urllib.parse.quote(str(kind), safe='')}")

    # share links: https://music.yandex.ru/playlists/lk.<token> resolve to the underlying playlist
    # (full track list included) via /playlist/<token>.
    def playlist_share(self, token):
        return self.request(f"/playlist/{urllib.parse.quote(str(token), safe='')}")

    def likes_tracks(self, user=None):
        return self.request(f"/users/{urllib.parse.quote(str(user or 'me'), safe='')}/likes/tracks")

    def tracks(self, ids):
        out = []
        for i in range(0, len(ids), 50):
            batch = ids[i : i + 50]
            result = self.request("/tracks", {"trackIds": ",".join(batch), "with": "pos"})
            out.extend(result or [])
        return out

    def search_track(self, text):
        # `page` is mandatory (without it: HTTP 400 "validate: page: Parameter value is not set"),
        # and the request must go out ANONYMOUSLY — search answers a bare
        # `User-Agent: Yandex-Music-API` request with 200, while attaching the stored OAuth token
        # gets a 401 (an expired token must not take the whole lookup down).
        return self.request("/search", {"type": "track", "text": text, "page": "1"}, True)

    def album_with_tracks(self, album_id):
        path = f"/albums/{urllib.parse.quote(str(album_id), safe='')}"
        try:
            return self.request(f"{path}/with-tracks")
        except Exception as err:
            # Decision 2026-09-21: Yandex WAF 403s /with-tracks even for the owning token —
            # fall back to WAF-safe plain /albums/{id} + batched /tracks.
            msg = str(err)
            if "HTTP 403" not in msg:
                raise  # only the WAF-403 is the fallback trigger
            album = self.request(path)
            if not album:
                return None
            entries = [t for v in (album.get("volumes") or []) for t in v] or []
            needs_fetch = any((not t) or (isinstance(t, dict) and not t.get("title")) for t in entries)
            if needs_fetch and entries:
                ids = [str((t or {}).get("id") if isinstance(t, dict) else t) for t in entries]
                full = [t for t in self.tracks(ids) if t]
                fi = 0
                new_volumes = []
                for v in album.get("volumes") or []:
                    row = []
                    for t in v:
                        if t and isinstance(t, dict) and t.get("title"):
                            row.append(t)
                        else:
                            repl = _at(full, fi)
                            fi += 1
                            if repl is not None:
                                row.append(repl)
                    new_volumes.append(row)
                album["volumes"] = new_volumes
            return album


def _at(lst, i, default=None):
    return lst[i] if 0 <= i < len(lst) else default


def track_meta(raw):
    """raw dict -> TrackMeta dict (same shape as the node build); None when unusable."""
    if not raw or raw.get("error"):
        return None
    title = raw.get("title") or (raw.get("track") or {}).get("title")
    if not title:
        return None
    duration_ms = 0
    for cand in (raw.get("durationMs"), (raw.get("track") or {}).get("durationMs"), raw.get("length")):
        if cand is not None:  # node `??` — a real 0 must stay 0
            duration_ms = cand
            break
    raw_artists = raw.get("artists") or (raw.get("track") or {}).get("artists") or []
    artists = [a.get("name") for a in raw_artists if a.get("name")]
    albums = raw.get("albums") or []
    album = None
    if albums:
        a0 = albums[0]
        album = a0.get("title") or a0.get("name") or a0.get("version")
    return {
        "title": title,
        "artists": artists if artists else ["Unknown"],
        "album": album,
        "duration": round(duration_ms / 1000),
        "sourceId": str(raw.get("realId") or raw.get("id") or ""),
    }


def track_meta_from_id(raw_id):
    id_ = (raw_id or {}).get("trackId") if isinstance(raw_id, dict) else None
    if id_ is None and isinstance(raw_id, dict):
        id_ = raw_id.get("id")
    if id_ is None:
        id_ = raw_id
    if id_ is None:
        return None
    return str(id_)


def _expand_tracks(raw_tracks, client):
    metas = [track_meta(t) for t in raw_tracks]
    missing_ids = [
        track_meta_from_id(t) for i, t in enumerate(raw_tracks) if metas[i] is None
    ]
    missing_ids = [x for x in missing_ids if x]
    if not missing_ids:
        return [m for m in metas if m]
    full = client.tracks(missing_ids)
    for t in full:
        m = track_meta(t)
        if m:
            for i, raw in enumerate(raw_tracks):
                if track_meta_from_id(raw) == m["sourceId"]:
                    metas[i] = m
                    break
    return [m for m in metas if m]


def fetch_collections(target, client):
    mode = target.get("mode")
    if mode == "playlist":
        pl = (
            client.playlist_share(target["shareToken"])
            if target.get("shareToken")
            else client.playlist(target["kind"], target["user"])
        )
        if not pl:
            raise Exception("playlist not found or not accessible")
        metas = _expand_tracks(pl.get("tracks") or [], client)
        return [{"title": pl.get("title") or "Playlist", "tracks": metas}]

    if mode == "liked":
        data = client.likes_tracks(target.get("user"))
        ids = [
            x
            for x in (track_meta_from_id(t) for t in (data or {}).get("tracks") or [])
            if x
        ]
        full = client.tracks(ids)
        metas = [m for m in (track_meta(t) for t in full) if m]
        return [{"title": "Liked from Yandex Music", "tracks": metas}]

    if mode == "album":
        album = client.album_with_tracks(target["albumId"])
        if not album:
            raise Exception("album not found")
        return [{"title": album.get("title") or "Album", "tracks": album_tracks(album)}]

    raise Exception(f"unknown mode: {mode}")


def album_tracks(album):
    metas = []
    for volume in album.get("volumes") or []:
        for t in volume:
            m = track_meta(t)
            if m:
                metas.append(m)
    return metas
