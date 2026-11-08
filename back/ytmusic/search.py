"""YouTube Music search — port of back-node-js/src/ytmusic/search.ts.

Uses the `ytmusicapi` python package where node used ytmusic-api. The candidate shape returned
here is identical to the node build's ({videoId, title, artists as ONE string, duration}); the
shape adaptation lives in _adapt(): python ytmusicapi returns `title` / `artists: [{name}]` /
`duration_seconds` where the node lib returned `name` / `artist: {name}` / `duration`.
"""
import re
import threading
import time

import requests

import ytmusicapi

from config import apply_ytm_proxy, settings
from lib.logger import logger

_lock = threading.Lock()
_instance = None


class _TimeoutSession(requests.Session):
    """A requests session with a default timeout on every send.

    ytmusic-api inherited `axios.defaults.timeout = settings.ytmTimeout` in the node build, because
    ytmusic-api has NO timeout of its own — a blocked YouTube would hang forever instead of failing.
    requests has no session-level default timeout either, so we wrap `send` (ytmusicapi drives the
    session through send of prepared requests).
    """

    def __init__(self, timeout_s: float):
        super().__init__()
        self._timeout_s = timeout_s

    def send(self, prepared, **kwargs):  # noqa: D102
        kwargs.setdefault("timeout", self._timeout_s)
        return super().send(prepared, **kwargs)


def _build():
    apply_ytm_proxy()
    session = _TimeoutSession(settings.ytm_timeout / 1000)
    if settings.ytm_proxy:
        session.proxies.update({"http": settings.ytm_proxy, "https": settings.ytm_proxy})
    yt = ytmusicapi.YTMusic(requests_session=session)
    return yt


def get_ytmusic():
    """Lazily built singleton; a failed init resets the slot so the next call retries (node parity)."""
    global _instance
    if _instance is not None:
        return _instance
    with _lock:
        if _instance is None:
            _instance = _build()
    return _instance


def _reset():
    global _instance
    with _lock:
        _instance = None


def with_retry(fn, attempts=3):
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as err:  # noqa: BLE001 — node catches everything here too
            last_err = err
            logger.error(f"ytmusic: attempt {i + 1}/{attempts} failed", err, "withRetry")
            msg = str(err)
            # Ported verbatim from the node build, including its quirk: the sleep happens unless
            # this was the last attempt AND the message does not look retryable.
            import re  # noqa: F811 — kept close to the ported condition for diffing against node

            if re.search(r"429|rate|fetch failed|timeout|ENOTFOUND|ECONNREFUSED|socket", msg, re.IGNORECASE) or i < attempts - 1:
                time.sleep(min(1000 * 2 ** i, 8000) / 1000)
    raise last_err


def _adapt(song: dict) -> dict:
    artists = song.get("artists") or []
    return {
        "videoId": song.get("videoId"),
        "title": song.get("title"),
        # node: `s.artist?.name ?? ''` — the single artist string the matcher scores against
        "artists": artists[0].get("name") or "" if artists else "",
        "duration": song.get("duration_seconds"),
    }


def search_songs(query: str) -> list[dict]:
    yt = get_ytmusic()
    query_time = time.time() * 1000
    songs = with_retry(lambda: yt.search(query, filter="songs"))
    # YT Music search intermittently yields rows with no videoId (mix rows, headers). They can never
    # produce a link, so they must not be able to win the scoring and blank out a result.
    usable = [s for s in songs if isinstance(s.get("videoId"), str) and len(s["videoId"]) > 0]
    logger.log(
        "ytmusic: search ok",
        {
            "query": query,
            "resultCount": len(usable),
            "dropped": len(songs) - len(usable),
            "elapsedMs": round(time.time() * 1000 - query_time),
        },
    )
    return [_adapt(s) for s in usable]
