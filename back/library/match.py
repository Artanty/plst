"""Library song matching — port of back-node-js/src/library/match.ts.

The matcher itself is matcher.py (reused, not reimplemented — a second scoring implementation
would drift and quietly disagree with the first). searchSongs is injectable so tests can run
without YouTube; live matching has to be verified behind YTM_PROXY or on another host.
"""
from concurrent.futures import ThreadPoolExecutor

from config import settings
from matcher import build_queries, match_track
from lib.logger import logger

MATCH_USABLE_STATUSES = ("matched", "uncertain")


def match_usable(res: dict) -> bool:
    """model.ts matchUsable: matched/uncertain WITH a videoId — the only results worth keeping."""
    return res.get("status") in MATCH_USABLE_STATUSES and bool(res.get("videoId"))


def is_confident(score) -> bool:
    """A stored video id is only as good as the score behind it, and the score decides whether it
    is usable. `uncertain` means the matcher found a plausible video that it does not trust.
    Derived from the score rather than stored, which is what the pipeline does on a cache hit.
    """
    return score is not None and score >= settings.match_accept


def search_failure_reason(err: Exception) -> str:
    """Turns a thrown search error into a reason a human can act on: the underlying cause and —
    when one is configured — that every request goes through YTM_PROXY, because a dead local
    proxy looks exactly like "YouTube is down". (The string, incl. the YTM_PROXY hint, is
    byte-parity with the node build.)
    """
    raw = str(err)
    # First line only — exception chains / request dumps carry whole configs after a newline.
    cause = raw.split("\n")[0][:200]
    if settings.ytm_proxy:
        return f"{cause} — all YouTube Music requests go through YTM_PROXY={settings.ytm_proxy}; is that proxy running?"
    return cause


def _to_track_meta(song: dict) -> dict:
    return {
        "title": song.get("title"),
        "artists": song.get("artists") or [""],
        "album": song.get("album"),
        "duration": song.get("duration"),
        # The library is keyed by its own dedup hash, not a Yandex track id, and the matcher only
        # uses sourceId for reporting.
        "sourceId": None,
    }


def match_song(song: dict, search_songs=None) -> dict:
    """Match one song. Tries each query variant in turn and keeps the best usable result; the
    variants go from most to least specific, so a confident hit on the first one is the one to
    trust (early stop). A dead search is search_failed, NEVER not_found.
    """
    search = search_songs or _default_search
    if song.get("yt_video_id"):
        logger.log(
            "library: match skipped, already matched",
            {"songId": song.get("id"), "title": song.get("title"), "videoId": song["yt_video_id"]},
        )
        return {"status": "matched", "score": 0, "videoId": song["yt_video_id"]}

    track = _to_track_meta(song)
    best = None
    for query in build_queries(track):
        try:
            candidates = search(query)
        except Exception as err:
            # Name the cause: on a blocked machine every query fails this way, and "match failed"
            # with no reason sends you looking for a scoring bug instead of a network one.
            # search_failed, NOT not_found: nothing was asked, so nothing was answered about the
            # song. Reporting a dead proxy as "the song is not in the catalog" is a confident
            # wrong answer.
            logger.error(f'youtube search failed for "{query}"', err, "libraryMatch")
            return {"status": "search_failed", "score": 0, "videoId": None, "reason": search_failure_reason(err)}
        res = match_track(track, candidates)
        if match_usable(res) and (best is None or res["score"] > best["score"]):
            best = res
        if match_usable(res) and res["score"] >= settings.match_accept:
            break
    return best if best is not None else {"status": "not_found", "score": 0, "videoId": None}


def match_songs(songs, search_songs=None, concurrency=None):
    """Match a batch, through a bounded worker pool so a 50-song playlist cannot open 50
    simultaneous connections to a host that may well be blocked.
    """
    search = search_songs or _default_search
    if concurrency is None:
        concurrency = settings.search_concurrency

    def one(song):
        try:
            res = match_song(song, search)
            return {**res, "songId": song.get("id"), "title": song.get("title"), "cached": False, "error": None}
        except Exception as err:
            error = str(err)
            # Same reasoning as match_song's catch: an unexpected throw means the song was never
            # ANSWERED, so it must not masquerade as a real "not in the catalog".
            return {
                "status": "search_failed",
                "score": 0,
                "videoId": None,
                "reason": error,
                "songId": song.get("id"),
                "title": song.get("title"),
                "cached": False,
                "error": error,
            }

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        return list(pool.map(one, songs))


def _default_search(query: str):
    # Imported lazily: importing ytmusicapi at module load would make every test pay for it.
    from ytmusic.search import search_songs as search_songs_real

    return search_songs_real(query)
