"""Track metadata types + match helpers — port of back-node-js/src/model.ts (and cacheKey from
pipeline.ts, per the port plan).

TrackMeta / MatchResult / Candidate / Collection are plain dicts in the python port (keys are the
node property names, verbatim — they surface in JSON payloads):

  TrackMeta   {title: str, artists: list[str], album: str | None, duration: int, sourceId: str | None}
  MatchResult {status, score, videoId?, ytTitle?, ytArtist?, ytDuration?, reason?}
  Candidate   {videoId: str, title: str, artists: str, duration: int | None}
  Collection  {title: str, tracks: list[TrackMeta]}

'search_failed' is deliberately NOT 'not_found': the first means "YouTube Music could not be
asked at all" (blocked network, dead proxy — see YTM_PROXY), the second means "asked, and the
song is not in the catalog". Conflating them reported a dead proxy as a missing Linkin Park
track (live report 2026-10-19). Only 'not_found' is an answer about the song.
"""
import hashlib

# Bump this whenever scoring changes. match_cache stores the verdict AND the score, so without a
# version in the key a scoring fix silently never reaches already-cached tracks.
SCORE_VERSION = 2


def artist_str(track: dict) -> str:
    return ", ".join(track["artists"])


def match_usable(res: dict) -> bool:
    return (res.get("status") in ("matched", "uncertain")) and bool(res.get("videoId"))


def cache_key(track: dict) -> str:
    plain = f"v{SCORE_VERSION}|{track['title']}|{artist_str(track)}|{track['duration']}"
    return hashlib.sha1(plain.encode("utf-8")).hexdigest()
