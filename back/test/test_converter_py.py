"""Admin/HTTP surface of the converter — the Flask test client scenarios for /migrate, /jobs and
/job/<id>?format=json|links (port of the routes in back-node-js/src/server.ts; the node suite
covered the pipeline itself in pipeline.test.ts and the HTTP wiring only in e2e usage, so the
status codes / messages / JSON shapes here are pinned to the node routes' behavior exactly).
"""
import json
import time

import pytest

from pipeline import PipelineDeps


def make_collections():
    return [{
        "title": "Test Album",
        "tracks": [
            {"title": "Song A", "artists": ["Artist X"], "album": "Album", "duration": 200, "sourceId": "1:1"},
            {"title": "Song B", "artists": ["Artist Y"], "album": "Album", "duration": 180, "sourceId": "1:3"},
            {"title": "Missing Song", "artists": ["Zed"], "album": None, "duration": 100, "sourceId": "1:4"},
        ],
    }]


CANDS = {
    "Song A Artist X": [{"videoId": "vidA", "title": "Song A", "artists": "Artist X", "duration": 201}],
    "Song B Artist Y": [{"videoId": "vidB", "title": "Song B", "artists": "Artist Y", "duration": 180}],
}


def fake_pipeline_deps():
    return PipelineDeps(
        fetch_collections=lambda target: make_collections(),
        search_songs=lambda query: CANDS.get(" ".join(query.split())) or [],
    )


@pytest.fixture()
def converter_client(library, converter_store, monkeypatch):
    import threading

    from app import create_app

    # Node's openStore ran the CREATE TABLE ladder on boot; the shared conftest fixture hands out
    # a bare Store, so make sure the schema exists before the first request touches it.
    converter_store.init()

    # The conftest Database hands out ONE raw connection, which corrupts the MySQL packet stream
    # if a background thread queries it while the test thread polls. Run the job synchronously
    # instead (node's own suite also drove runJob without concurrency).
    class SyncThread:
        def __init__(self, target, args=(), daemon=None):
            self._target, self._args = target, args

        def start(self):
            self._target(*self._args)

    monkeypatch.setattr(threading, "Thread", SyncThread)
    app = create_app(store=converter_store, library=library, pipeline_deps=fake_pipeline_deps())
    app.config["TESTING"] = True
    return app.test_client()


def wait_done(store, job_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = store.get_job(job_id)
        if job and job["status"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    return store.get_job(job_id)


def migrate(client, **fields):
    return client.post("/migrate", data=fields)


# ---- /migrate validation: node's order and messages exactly ------------------------------

def test_migrate_bad_json_400(converter_client):
    res = migrate(converter_client, mode="json", source='{"nope":')
    assert res.status_code == 400
    assert res.content_type.startswith("text/plain")
    assert res.get_data(as_text=True).startswith("not valid JSON: ")


def test_migrate_json_all_rows_without_title_400(converter_client):
    res = migrate(converter_client, mode="json", source=json.dumps([{"title": ""}, {"artists": ["X"]}]))
    assert res.status_code == 400
    assert res.get_data(as_text=True) == "no usable rows: 2 input row(s), all missing a title"


def test_migrate_unknown_mode_400(converter_client):
    res = migrate(converter_client, mode="bogus", source="whatever")
    assert res.status_code == 400
    assert res.get_data(as_text=True) == "unknown mode: bogus"


def test_migrate_album_mode_with_playlist_url_400(converter_client):
    res = migrate(converter_client, mode="album",
                  source="https://music.yandex.ru/users/me/playlists/123")
    assert res.status_code == 400
    assert res.get_data(as_text=True) == "expected an album URL like music.yandex.ru/album/<id>"


def test_migrate_playlist_mode_with_album_url_400(converter_client):
    res = migrate(converter_client, mode="playlist", source="https://music.yandex.ru/album/123")
    assert res.status_code == 400
    assert res.get_data(as_text=True) == "expected a playlist URL like music.yandex.ru/users/<user>/playlists/<kind>"


def test_migrate_liked_without_user_400(converter_client):
    res = migrate(converter_client, mode="liked", source="")
    assert res.status_code == 400
    assert res.get_data(as_text=True) == "Yandex user name is required"


# ---- /migrate happy path: 303 to the job page, exactly like node --------------------------

def test_migrate_json_creates_job_and_redirects_303(converter_client, converter_store):
    blob = json.dumps([
        {"title": "Song A", "artists": ["Artist X"], "durationS": 200},
        {"title": "Song B", "artists": ["Artist Y"], "durationS": 180},
    ])
    res = migrate(converter_client, mode="json", source=blob)
    assert res.status_code == 303
    location = res.headers["Location"]
    assert location.startswith("/job/")
    job_id = location.rsplit("/", 1)[1]
    job = wait_done(converter_store, job_id)
    assert job["status"] == "done"
    assert job["source"] == "pasted JSON, 2 tracks"


def test_migrate_album_url_runs_the_pipeline(converter_client, converter_store):
    res = migrate(converter_client, mode="album", source="https://music.yandex.ru/album/1")
    assert res.status_code == 303
    job_id = res.headers["Location"].rsplit("/", 1)[1]
    job = wait_done(converter_store, job_id)
    assert job["status"] == "done"
    items = converter_store.job_items(job_id)
    assert [i["status"] for i in items] == ["matched", "matched", "not_found"]


# ---- /job/<id> formats --------------------------------------------------------------------

@pytest.fixture()
def done_json_job(converter_client, converter_store):
    blob = json.dumps([
        {"title": "Song A", "artists": ["Artist X"], "durationS": 200},
        {"title": "Song B", "artists": ["Artist Y"], "durationS": 180},
    ])
    res = migrate(converter_client, mode="json", source=blob)
    job_id = res.headers["Location"].rsplit("/", 1)[1]
    wait_done(converter_store, job_id)
    return job_id


def test_job_format_json_shape(converter_client, converter_store, done_json_job):
    res = converter_client.get(f"/job/{done_json_job}?format=json")
    assert res.status_code == 200
    payload = res.get_json()
    assert set(payload.keys()) == {"job", "items", "summary"}
    assert payload["job"]["id"] == done_json_job
    assert payload["job"]["status"] == "done"
    assert payload["summary"] == [
        {"title": "Pasted track JSON", "matched": 2, "uncertain": 0, "not_found": 0,
         "skipped_dup": 0, "links": 2}
    ]
    assert [i["status"] for i in payload["items"]] == ["matched", "matched"]
    assert payload["items"][0]["yt_video_id"] == "vidA"


def test_job_format_links_plain_text(converter_client, done_json_job):
    res = converter_client.get(f"/job/{done_json_job}?format=links")
    assert res.status_code == 200
    assert res.content_type.startswith("text/plain")
    assert res.get_data(as_text=True) == (
        "https://music.youtube.com/watch?v=vidA\nhttps://music.youtube.com/watch?v=vidB"
    )


def test_job_default_view_is_html(converter_client, done_json_job):
    res = converter_client.get(f"/job/{done_json_job}")
    assert res.status_code == 200
    assert res.content_type.startswith("text/html")
    body = res.get_data(as_text=True)
    assert done_json_job in body
    assert "Song A" in body


def test_job_unknown_id_404(converter_client):
    res = converter_client.get("/job/nope")
    assert res.status_code == 404
    assert res.content_type.startswith("text/plain")
    assert res.get_data(as_text=True) == "job not found"


# ---- /jobs ---------------------------------------------------------------------------------

def test_jobs_page_lists_jobs(converter_client, done_json_job):
    res = converter_client.get("/jobs")
    assert res.status_code == 200
    assert res.content_type.startswith("text/html")
    assert done_json_job in res.get_data(as_text=True)


def test_index_page_renders(converter_client):
    res = converter_client.get("/")
    assert res.status_code == 200
    body = res.get_data(as_text=True)
    assert "Convert Yandex Music playlists/albums" in body
    assert 'action="/migrate"' in body
