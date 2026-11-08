"""Port of back-node-js/test/pipeline.test.ts — scenarios 1:1, with the store mocked
(node's suite used a real MySQL store via makeStore; here the same duck-typed Store surface
is faked in memory so the suite needs no DB and no network)."""
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import PipelineDeps, run_job, start_job  # noqa: E402


class FakeStore:
    """Same method surface as db.Store (the seams pipeline.ts injects)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}
        self.items = []
        self.cache = {}

    def create_job(self, mode, source):
        with self.lock:
            job_id = f"job{len(self.jobs) + 1}"
            self.jobs[job_id] = {"id": job_id, "mode": mode, "source": source, "status": "pending", "error": None}
            return job_id

    def set_job(self, job_id, fields):
        with self.lock:
            self.jobs[job_id].update(fields)

    def add_total(self, job_id, delta):
        with self.lock:
            self.jobs[job_id]["total"] = self.jobs[job_id].get("total", 0) + delta

    def inc_processed(self, job_id):
        with self.lock:
            self.jobs[job_id]["processed"] = self.jobs[job_id].get("processed", 0) + 1

    def add_items(self, rows):
        with self.lock:
            self.items.extend(rows)

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def job_items(self, job_id):
        return sorted(
            (r for r in self.items if r["job_id"] == job_id),
            key=lambda r: (r["collection_idx"], r["position"]),
        )

    def cache_get(self, key):
        row = self.cache.get(key)
        return dict(row) if row else None

    def cache_put(self, key, video_id, yt_title, yt_artist, yt_duration, score):
        with self.lock:
            self.cache[key] = {
                "key": key, "video_id": video_id, "score": score,
                "yt_title": yt_title, "yt_artist": yt_artist, "yt_duration": yt_duration,
            }


def make_collections():
    return [{
        "title": "Test Album",
        "tracks": [
            {"title": "Song A", "artists": ["Artist X"], "album": "Album", "duration": 200, "sourceId": "1:1"},
            {"title": "Song A", "artists": ["Artist X"], "album": "Album", "duration": 200, "sourceId": "1:2"},  # exact dupe
            {"title": "Song B", "artists": ["Artist Y"], "album": "Album", "duration": 180, "sourceId": "1:3"},
            {"title": "Missing Song", "artists": ["Zed"], "album": None, "duration": 100, "sourceId": "1:4"},
        ],
    }]


CANDS = {
    "Song A Artist X": [{"videoId": "vidA", "title": "Song A", "artists": "Artist X", "duration": 201}],
    # Clean studio-cut title. This suite is about orchestration (dedupe/summary/cache), not scoring:
    # qualifier-vs-studio-cut scoring is asserted in the matcher tests. A "(Live)" title here used to be
    # a confident 'matched' and no longer is, which is correct but is not what this test is measuring.
    "Song B Artist Y": [{"videoId": "vidB", "title": "Song B", "artists": "Artist Y", "duration": 180}],
}


def fake_deps():
    return PipelineDeps(
        fetch_collections=lambda target: make_collections(),
        search_songs=lambda query: CANDS.get(" ".join(query.split())) or [],
    )


def test_pipeline_full_job_mocked():
    store = FakeStore()
    deps = fake_deps()

    job_id = store.create_job("album", "https://music.yandex.ru/album/1")
    run_job(store, job_id, "album", "https://music.yandex.ru/album/1", deps)

    job = store.get_job(job_id)
    assert job["status"] == "done"
    assert job["error"] is None

    summary = json.loads(job["summary_json"])
    assert summary[0]["matched"] == 2
    assert summary[0]["skipped_dup"] == 1
    assert summary[0]["not_found"] == 1
    assert summary[0]["links"] == 2

    items = store.job_items(job_id)
    assert [i["status"] for i in items] == ["matched", "skipped_dup", "matched", "not_found"]

    # second run: A and B resolved from cache without new searches
    searches = []

    def counting_search(query):
        searches.append(query)
        return deps.search_songs(query)

    counting_deps = PipelineDeps(fetch_collections=deps.fetch_collections, search_songs=counting_search)
    job2 = store.create_job("album", "https://music.yandex.ru/album/1")
    run_job(store, job2, "album", "https://music.yandex.ru/album/1", counting_deps)
    assert store.get_job(job2)["status"] == "done"
    # missing song has no cached match -> still searches; A/B must not be searched
    assert len(searches) < 6
    items2 = store.job_items(job2)
    assert [i["status"] for i in items2] == ["matched", "skipped_dup", "matched", "not_found"]


def test_pipeline_failed_job_reports_error():
    store = FakeStore()

    def boom(target):
        raise RuntimeError("yandex down")

    deps = PipelineDeps(fetch_collections=boom, search_songs=lambda q: [])
    job_id = store.create_job("album", "https://music.yandex.ru/album/1")
    run_job(store, job_id, "album", "https://music.yandex.ru/album/1", deps)
    job = store.get_job(job_id)
    assert job["status"] == "failed"
    assert job["error"] == "yandex down"


def test_start_job_runs_in_background_and_stores_short_json_label():
    store = FakeStore()
    deps = fake_deps()
    blob = json.dumps([
        {"title": "Song A", "artists": ["Artist X"], "durationS": 200},
        {"title": "Song B", "artists": ["Artist Y"], "durationS": 180},
    ])
    job_id = start_job(store, "json", blob, deps)
    assert store.get_job(job_id)["source"] == "pasted JSON, 2 tracks"
    deadline = time.time() + 5
    while store.get_job(job_id)["status"] != "done" and time.time() < deadline:
        time.sleep(0.01)
    assert store.get_job(job_id)["status"] == "done"
    assert [i["status"] for i in store.job_items(job_id)] == ["matched", "matched"]
