"""Yandex "listen" lookup — port of back-node-js/src/library/yandex.ts.

searchTrack is injectable (node's YandexDeps) so tests never touch the network — the same
pattern as match.py's search injection.
"""
from yandex.client import YandexClient
from lib.logger import logger


def default_search_track(query: str):
    return YandexClient().search_track(query)


def yandex_track_url(track_id: str) -> str:
    return f"https://music.yandex.ru/track/{track_id}"


def build_query(song: dict) -> str:
    """The search text: artists then title, the way a human would type it into Yandex Music."""
    return " ".join([*(song.get("artists") or []), song.get("title") or ""])


def _candidates(result):
    """All candidates Yandex offers, in rank order: `best` first (its own verdict), then `hits`
    (the older search shape), then `results` (the shape /search actually returns live as of
    2026-10-13). Only a candidate with a real id is usable.
    """
    def id_of(t):
        if not isinstance(t, dict):
            return None
        return t.get("realId") if t.get("realId") is not None else t.get("id")

    out = []
    best = (result or {}).get("best")
    if isinstance(best, dict) and best.get("type") == "track" and id_of(best.get("data")) is not None:
        out.append(best["data"])
    tracks = (result or {}).get("tracks") or {}
    for t in [*(tracks.get("hits") or []), *(tracks.get("results") or [])]:
        if id_of(t) is not None:
            out.append(t)
    return out


def _norm(s) -> str:
    return " ".join(str("" if s is None else s).lower().split())


def _score_candidate(t, song) -> int:
    # 2 for a title that EQUALS the library song's (case/space insensitive), 2 more for sharing
    # an artist name. Library artist names come from the same Yandex DOM the search does, so
    # equality is the honest test.
    title_score = 2 if _norm((t or {}).get("title")) == _norm(song.get("title")) else 0
    cand_artists = [_norm(a.get("name")) for a in (t or {}).get("artists") or []]
    artist_hit = any(_norm(a) in cand_artists for a in song.get("artists") or [])
    return title_score + (2 if artist_hit else 0)


def _pick_track(result, song):
    # A song with artists recorded must match on BOTH title and artist (4); a song with no artists
    # recorded settles for the title (2). Never fall back to "the first thing Yandex said".
    best = None
    best_score = 0
    for t in _candidates(result):
        s = _score_candidate(t, song)
        if s > best_score:
            best = t
            best_score = s
    return best if best_score >= (4 if song.get("artists") else 2) else None


def find_track_url(song, search_track=default_search_track):
    """Resolve a song to its music.yandex.ru track page by text search. Two queries, best-first:
    artists+title, then — if that yields nothing acceptable — the title alone (the artist text
    actually POLLUTES Yandex's ranking, so the title-only retry is the query that usually wins).

    Returns None on a miss — never a guessed URL. Errors propagate; the route turns them into a 502.
    """
    if not build_query(song).strip():
        return None
    attempts = [build_query(song)] + ([song["title"]] if (song.get("title") or "").strip() else [])
    track = None
    for query in attempts:
        track = _pick_track(search_track(query), song)
        if track:
            break
    if not track:
        logger.log("yandex: no search match", {"query": build_query(song)}, "findTrackUrl")
        return None
    raw_id = track.get("realId") if track.get("realId") is not None else track.get("id")
    artists = [a.get("name") for a in track.get("artists") or [] if isinstance(a, dict) and a.get("name")]
    return {
        "url": yandex_track_url(str(raw_id)),
        "trackId": str(raw_id),
        "title": str(track.get("title") or ""),
        "artists": artists,
    }
