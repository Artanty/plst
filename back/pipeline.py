"""Conversion pipeline — port of back-node-js/src/pipeline.ts (job runner).

Parity notes (judgment calls):
- Node fired `void runJob(...)` on a promise; here start_job spawns a daemon threading.Thread.
- Node throttled searches with PQueue(concurrency = settings.searchConcurrency); here a
  threading.Semaphore-sized SearchQueue stands in. deps.search_songs is a *sync* callable —
  the injected seams are the same as node's PipelineDeps (fetchCollections + searchSongs +
  the duck-typed store methods), so tests need no DB and no network.
- Store is duck-typed (node: `Store` interface); the real one is db.Store, whose methods
  create_job / set_job / add_total / inc_processed / add_items / get_job / job_items /
  cache_get / cache_put line up 1:1.
"""
import json
import threading

from config import settings
from lib.logger import logger
from matcher import build_queries, match_track
from model import artist_str, cache_key, match_usable
from paste_json import parse_track_json
from url_parser import from_form


class PipelineDeps:
    """The seams node injected via the PipelineDeps interface. Callables are sync here."""

    def __init__(self, fetch_collections, search_songs):
        self.fetch_collections = fetch_collections  # (target: dict) -> list[dict]
        self.search_songs = search_songs            # (query: str) -> list[dict]


class SearchQueue:
    """PQueue stand-in: caps concurrent deps.search_songs calls at settings.search_concurrency."""

    def __init__(self, concurrency: int | None = None):
        self._sem = threading.Semaphore(concurrency or settings.search_concurrency)

    def run(self, fn, *args):
        with self._sem:
            return fn(*args)


def match_with_search(store, track: dict, deps: PipelineDeps, queue: SearchQueue) -> dict:
    key = cache_key(track)
    logger.log(
        "pipeline: match start",
        {"title": track["title"], "artists": track["artists"], "duration": track["duration"]},
        fn="pipeline.match_with_search",
    )
    cached = store.cache_get(key)
    if cached and cached.get("video_id"):
        logger.log(
            "pipeline: cache hit",
            {"key": key, "videoId": cached["video_id"], "score": cached.get("score")},
            fn="pipeline.match_with_search",
        )
        score = cached.get("score")
        return {
            "status": "matched" if (score or 0) >= settings.match_accept else "uncertain",
            "score": score if score is not None else 0,
            "videoId": cached.get("video_id"),
            "ytTitle": cached.get("yt_title"),
            "ytArtist": cached.get("yt_artist"),
            "ytDuration": cached.get("yt_duration"),
        }

    best = None
    for query in build_queries(track):
        candidates = []
        try:
            candidates = queue.run(deps.search_songs, query)
        except Exception as err:
            logger.error(f'search failed for "{query}"', err, "pipeline.match_with_search")
        result = match_track(track, candidates)
        if best is None or result["score"] > best["score"]:
            best = result
        if result["status"] == "matched":
            best = result
            break

    if best is None:
        best = {"status": "not_found", "score": 0}
    logger.log(
        "pipeline: match done",
        {"status": best["status"], "score": best["score"], "videoId": best.get("videoId")},
        fn="pipeline.match_with_search",
    )
    # Cache ONLY confident matches. An 'uncertain' result is a guess we already doubt: caching it
    # froze a wrong low-confidence link forever and the track could never be re-searched, so a re-run
    # could not improve it. Re-searching the few failures per run is cheap and lets them recover.
    if best.get("videoId") and best["status"] == "matched":
        store.cache_put(
            key, best["videoId"], best.get("ytTitle") or "", best.get("ytArtist") or "",
            best.get("ytDuration"), best["score"],
        )
    return best


def run_collection(store, job_id: str, idx: int, coll: dict, deps: PipelineDeps, queue: SearchQueue) -> dict:
    tracks = coll["tracks"]
    store.add_total(job_id, len(tracks))

    seen = set()
    results = []  # [{position, track, res}]
    for position, track in enumerate(tracks):
        key = f"{track['title']}|{artist_str(track)}|{track['duration']}"
        if key in seen:
            results.append({"position": position, "track": track, "res": {"status": "skipped_dup", "score": 0}})
            continue
        seen.add(key)
        res = match_with_search(store, track, deps, queue)
        results.append({"position": position, "track": track, "res": res})
        store.inc_processed(job_id)

    rows = [
        {
            "job_id": job_id,
            "collection_idx": idx,
            "position": r["position"],
            "src_title": r["track"]["title"],
            "src_artist": artist_str(r["track"]),
            "src_duration": r["track"]["duration"],
            "status": r["res"]["status"],
            "score": r["res"]["score"],
            "yt_video_id": r["res"].get("videoId"),
            "yt_title": r["res"].get("ytTitle"),
            "yt_artist": r["res"].get("ytArtist"),
            "yt_duration": r["res"].get("ytDuration"),
            "collection_title": coll["title"],
        }
        for r in results
    ]
    store.add_items(rows)

    usable = {
        f"{r['track']['title']}|{artist_str(r['track'])}|{r['track']['duration']}"
        for r in results
        if match_usable(r["res"])
    }

    return {
        "title": coll["title"],
        "matched": sum(1 for r in results if r["res"]["status"] == "matched"),
        "uncertain": sum(1 for r in results if r["res"]["status"] == "uncertain"),
        "not_found": sum(1 for r in results if r["res"]["status"] == "not_found"),
        "skipped_dup": sum(1 for r in results if r["res"]["status"] == "skipped_dup"),
        "links": len(usable),
    }


def run_job(store, job_id: str, mode: str, source: str, deps: PipelineDeps) -> None:
    try:
        store.set_job(job_id, {"status": "running"})
        target = from_form(mode, source)
        # Pasted extension JSON: no Yandex request at all. That is the whole point of this mode — the
        # Yandex API is unreachable from here, and the tracks are already in hand.
        if target["mode"] == "json":
            collections = [{"title": "Pasted track JSON", "tracks": parse_track_json(source)["tracks"]}]
        else:
            collections = deps.fetch_collections(target)
        queue = SearchQueue()
        summaries = []
        idx = 0
        for coll in collections:
            if not coll["tracks"]:
                continue
            summaries.append(run_collection(store, job_id, idx, coll, deps, queue))
            idx += 1
        logger.log("pipeline: job done", {"jobId": job_id, "collections": len(summaries)}, fn="pipeline.run_job")
        store.set_job(job_id, {"status": "done", "summary_json": json.dumps(summaries)})
    except Exception as err:
        logger.error(f"job {job_id} failed", err, "pipeline.run_job")
        # node: err instanceof Error ? err.message : String(err) — python's str(err) is the message.
        store.set_job(job_id, {"status": "failed", "error": str(err)})


def start_job(store, mode: str, source: str, deps: PipelineDeps) -> str:
    # jobs.source is printed verbatim on the job page, so store a short label instead of the whole
    # pasted blob. runJob still gets the full text by argument.
    stored = f"pasted JSON, {len(parse_track_json(source)['tracks'])} tracks" if mode == "json" else source
    job_id = store.create_job(mode, stored)
    threading.Thread(target=run_job, args=(store, job_id, mode, source, deps), daemon=True).start()
    return job_id
