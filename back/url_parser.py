"""Yandex Music URL / form source parsing — port of back-node-js/src/url.ts (pure functions).

Result dicts use the node property names verbatim (mode/user/kind/albumId/shareToken/url) —
these feed fetchCollections and are stored/logged as-is. Error messages are byte-identical.
"""
import json
import re

from lib.logger import logger

Mode = str  # 'playlist' | 'liked' | 'album' | 'json'

_DOMAIN = r"(?:music\.yandex\.(?:ru|by|kz|am|az|ge|com|md|tm|kg|uz)\/)"
PLAYLIST_RE = re.compile(_DOMAIN + r"users/(?P<user>[^/]+)/playlists/(?P<kind>[^/?#&]+)", re.IGNORECASE)
# share links  https://music.yandex.ru/playlists/{token}
# token is either the legacy "lk.<uuid>" form or (2025+ web copy-link) a bare 36-char uuid; no user prefix in either.
SHARE_RE = re.compile(_DOMAIN + r"playlists/((?:lk\.)?[0-9a-fA-F-]{36})", re.IGNORECASE)
ALBUM_RE = re.compile(_DOMAIN + r"album/(?P<album>\d+)", re.IGNORECASE)


def parse_url(url: str) -> dict:
    url = url.strip()
    album = ALBUM_RE.search(url)
    if album:
        album_id = album.group("album")
        logger.log("url: album", {"albumId": album_id, "url": url}, fn="url")
        return {"mode": "album", "albumId": album_id, "url": url}
    share = SHARE_RE.search(url)
    if share:
        share_token = share.group(1)
        logger.log("url: share playlist", {"shareToken": share_token, "url": url}, fn="url")
        return {"mode": "playlist", "user": None, "shareToken": share_token, "url": url}
    m = PLAYLIST_RE.search(url)
    if m:
        user = m.group("user")
        kind = m.group("kind")
        if kind.lower() == "liked":
            logger.log("url: liked", {"user": user, "url": url}, fn="url")
            return {"mode": "liked", "user": user, "url": url}
        return {"mode": "playlist", "user": user, "kind": kind, "url": url}
    raise ValueError(f"unsupported Yandex Music URL: {json.dumps(url)}")


_BARE_SHARE_RE = re.compile(r"^lk\.[0-9a-fA-F-]{36}$")
_IN_URL_SHARE_RE = re.compile(r"/(lk\.[0-9a-fA-F-]{36})[/?#]?")


def from_form(mode: str, source: str) -> dict:
    source = source.strip()
    # Track JSON from the browser extension: there is no Yandex URL to parse. The body is validated by
    # the caller via parseTrackJson, which is the only thing that can actually reject it.
    if mode == "json":
        return {"mode": "json"}
    # node: /^lk\…$/.exec(source) || /\/(lk\…)[\/?#]?/.exec(source.split('music.yandex')[1] ?? '')
    parts = source.split("music.yandex", 1)
    after_domain = parts[1] if len(parts) > 1 else ""
    bare_share = _BARE_SHARE_RE.match(source) or _IN_URL_SHARE_RE.search(after_domain)
    # node enters the branch when bareShare?.[1] (group 1) OR the full-string lk test matches;
    # the first regex has no capture group, so a full-string match still resolves token = source.
    if (bare_share and bare_share.lastindex) or _BARE_SHARE_RE.match(source):
        token = bare_share.group(1) if bare_share and bare_share.lastindex else source
        logger.log(
            "url: share token routed to playlist",
            {"shareToken": token, "requestedMode": mode},
            fn="url",
        )
        return {"mode": "playlist", "user": None, "shareToken": token, "url": source}
    if mode == "playlist":
        t = parse_url(source)
        if t["mode"] != "playlist":
            raise ValueError("expected a playlist URL like music.yandex.ru/users/<user>/playlists/<kind>")
        return t
    if mode == "album":
        t = parse_url(source)
        if t["mode"] != "album":
            raise ValueError("expected an album URL like music.yandex.ru/album/<id>")
        return t
    if mode == "liked":
        user = source
        if "/" in user:
            m = re.search(r"/users/([^/?#&]+)", user)
            if m:
                user = m.group(1)
            else:
                user = user.rstrip("/").split("/")[-1] if user.rstrip("/") else ""
        if not user:
            raise ValueError("Yandex user name is required")
        return {"mode": mode, "user": user}
    raise ValueError(f"unknown mode: {mode}")
