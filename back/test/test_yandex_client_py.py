"""Port of back-node-js/test/library-yandex.test.ts (the lookup half — no DB) plus pure-unit
client tests for back/yandex/client.py against a faked requests session. No network, no MySQL.
"""
import pytest

from library.yandex import build_query, find_track_url, yandex_track_url
from yandex.client import YandexClient, track_meta, track_meta_from_id


# ------------------------------------------------------------------- lookup

# The real /search shape: `best` is Yandex's own verdict, `tracks.hits` the fallback list.
SEARCH_BEST = {
    "result": {
        "best": {"type": "track", "data": {"id": 42, "title": "Roxanne", "artists": [{"name": "The Police"}]}},
        "tracks": {
            "total": 2,
            "hits": [
                {"id": 42, "title": "Roxanne", "artists": [{"name": "The Police"}]},
                {"id": 43, "title": "Roxanne (Live)", "artists": [{"name": "The Police"}]},
            ],
        },
    },
}

SONG = {"title": "Roxanne", "artists": ["The Police"]}


def test_prefers_yandex_best_verdict_and_returns_track_page_url():
    ref = find_track_url(SONG, lambda q: SEARCH_BEST["result"])
    assert ref is not None
    assert ref["url"] == "https://music.yandex.ru/track/42"
    assert ref["trackId"] == "42"
    # What was matched travels back, so a wrong hit is visible on the button.
    assert ref["title"] == "Roxanne"
    assert ref["artists"] == ["The Police"]


def test_falls_back_to_first_hit_with_an_id_when_there_is_no_best():
    no_best = {"tracks": SEARCH_BEST["result"]["tracks"]}
    ref = find_track_url(SONG, lambda q: no_best)
    assert ref["trackId"] == "42"


def test_reads_the_live_results_shape():
    # Verified live 2026-10-13: no `best`, no `hits` — just { tracks: { results: [...] } }.
    live = {"tracks": {"total": 2, "results": SEARCH_BEST["result"]["tracks"]["hits"]}}
    ref = find_track_url(SONG, lambda q: live)
    assert ref["trackId"] == "42"


def test_prefers_title_and_artist_match_not_a_cover_ranked_above_it():
    # Verified live: the top hit for "The Police — Roxanne" is a karaoke cover.
    with_cover_first = {
        "tracks": {
            "results": [
                {"id": 6065484, "title": "Roxanne In the Style of the Police", "artists": [{"name": "Karaoke Universe"}]},
                {"id": 77, "title": "Roxanne", "artists": [{"name": "Sweet Little Band"}]},
                {"id": 42, "title": "Roxanne", "artists": [{"name": "The Police"}]},
            ],
        },
    }
    ref = find_track_url(SONG, lambda q: with_cover_first)
    assert ref["trackId"] == "42"
    # Case/space-insensitive equality: a casing drift must not lose the real track.
    casing = {
        "tracks": {
            "results": [
                {"id": 2, "title": "Roxanne (Remix)", "artists": [{"name": "Karaoke Band"}]},
                {"id": 1, "title": "  roxanne ", "artists": [{"name": "The Police"}]},
            ],
        },
    }
    assert find_track_url(SONG, lambda q: casing)["trackId"] == "1"


def test_returns_null_rather_than_someone_elses_song():
    # Verified live: a deliberately nonsense query still returned "Nobody Knows — Umeg".
    wrong = {
        "tracks": {
            "results": [
                {"id": 82197151, "title": "Nobody Knows", "artists": [{"name": "Umeg"}]},
                {"id": 5, "title": "Группа крови", "artists": [{"name": "Паша Кореец"}]},
            ],
        },
    }
    ref = find_track_url({"title": "Definitely Not A Song Ever", "artists": ["Nobody"]}, lambda q: wrong)
    assert ref is None


def test_retries_with_the_title_alone_when_artists_plus_title_finds_nothing():
    # Live-verified: "The Police Roxanne" buries the real track under karaoke; plain "Roxanne"
    # surfaces it. The second query is what makes listen actually work.
    queries = []
    karaoke_only = {"tracks": {"results": [{"id": 1, "title": "Roxanne", "artists": [{"name": "Sweet Little Band"}]}]}}
    real = {"tracks": {"results": [{"id": 6877483, "title": "Roxanne", "artists": [{"name": "The Police"}]}]}}

    def search(q):
        queries.append(q)
        return karaoke_only if len(queries) == 1 else real

    ref = find_track_url(SONG, search)
    assert queries == ["The Police Roxanne", "Roxanne"]
    assert ref["trackId"] == "6877483"


def test_does_not_search_twice_when_first_query_found_the_song():
    calls = []

    def search(q):
        calls.append(q)
        return SEARCH_BEST["result"]

    find_track_url(SONG, search)
    assert len(calls) == 1


def test_returns_null_on_a_miss_never_a_guessed_url():
    for empty in [{}, {"tracks": {"hits": []}}, None]:
        assert find_track_url(SONG, lambda q: empty) is None


def test_returns_null_rather_than_searching_when_song_has_nothing_to_search():
    calls = []

    def search(q):
        calls.append(q)
        return SEARCH_BEST

    assert find_track_url({"title": "", "artists": []}, search) is None
    assert calls == []


def test_propagates_a_yandex_failure():
    def failing(q):
        raise Exception("Yandex API HTTP 403")

    with pytest.raises(Exception, match="HTTP 403"):
        find_track_url(SONG, failing)


def test_builds_the_query_as_artists_then_title():
    assert build_query(SONG) == "The Police Roxanne"
    assert build_query({"title": "Solo", "artists": []}) == "Solo"


def test_accepts_a_track_id_real_id_first():
    ref = find_track_url(SONG, lambda q: {
        "best": {
            "type": "track",
            "data": {"realId": "abc", "id": 99, "title": "Roxanne", "artists": [{"name": "The Police"}]},
        },
    })
    assert ref["trackId"] == "abc"
    assert ref["url"] == yandex_track_url("abc")


# ------------------------------------------------------------------ client

class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body
        self.status_code = status
        self.ok = status < 400

    def json(self):
        if isinstance(self._body, bytes):
            raise ValueError("not json")
        return self._body


class FakeSession:
    def __init__(self, responses=None):
        self.calls = []  # (url, headers)
        self.proxies = {}
        self._responses = list(responses or [])

    def get(self, url, headers=None):
        self.calls.append((url, headers))
        return self._responses.pop(0) if self._responses else FakeResponse({})


def _client_with(session, **kw):
    return YandexClient(token="tok123", session=session, **kw)


def test_headers_carry_device_ids_and_oauth_token():
    s = FakeSession([FakeResponse({"result": {}})])
    client = _client_with(s)
    client.request("/x")
    url, headers = s.calls[0]
    assert url == "https://api.music.yandex.ru/x"
    assert headers["User-Agent"] == "Yandex-Music-API"
    assert headers["Accept-Language"] == "ru"
    assert headers["X-Yandex-Music-Device-Id"] == "7eaa39f9-c5b1-4181-a712-7c3e36670319"
    assert headers["X-Yandex-Music-Device-UUID"] == "7eaa39f9-c5b1-4181-a712-7c3e36670319"
    assert headers["Authorization"] == "OAuth tok123"


def test_anonymous_request_sends_no_authorization():
    s = FakeSession([FakeResponse({"result": {}})])
    _client_with(s).request("/search", {"type": "track", "text": "Roxanne", "page": "1"}, True)
    url, headers = s.calls[0]
    assert url == "https://api.music.yandex.ru/search?type=track&text=Roxanne&page=1"
    assert "Authorization" not in headers


def test_search_track_is_anonymous_with_mandatory_page():
    s = FakeSession([FakeResponse({"result": {"tracks": {"results": []}}})])
    client = _client_with(s)
    client.search_track("Roxanne")
    url, headers = s.calls[0]
    assert "/search?" in url and "type=track" in url and "text=Roxanne" in url and "page=1" in url
    assert "Authorization" not in headers


def test_api_error_object_names_the_cause():
    s = FakeSession([FakeResponse({"error": {"name": "NotFound", "message": "no track"}})])
    with pytest.raises(Exception, match=r"Yandex API error \[NotFound\]: no track"):
        _client_with(s).request("/x")


def test_api_error_string_is_not_swallowed():
    # A dead token answers {"error":"Unauthorized"} — a bare string, not an object.
    s = FakeSession([FakeResponse({"error": "Unauthorized"})])
    with pytest.raises(Exception, match=r"Yandex API error Unauthorized"):
        _client_with(s).request("/x")


def test_http_error_names_the_path():
    s = FakeSession([FakeResponse({}, status=403)])
    with pytest.raises(Exception, match="Yandex API HTTP 403 for /playlist/abc"):
        _client_with(s).request("/playlist/abc")


def test_result_missing_returns_none():
    s = FakeSession([FakeResponse({})])
    assert _client_with(s).request("/x") is None


def test_tracks_batches_by_50():
    s = FakeSession([FakeResponse({"result": [{"id": i} for i in range(50)]}),
                     FakeResponse({"result": [{"id": i} for i in range(10)]})])
    out = _client_with(s).tracks([str(i) for i in range(60)])
    assert len(out) == 60
    import urllib.parse

    first = urllib.parse.urlencode({"trackIds": ",".join(str(i) for i in range(50)), "with": "pos"})
    assert s.calls[0][0] == f"https://api.music.yandex.ru/tracks?{first}"
    second = urllib.parse.urlencode({"trackIds": ",".join(str(i) for i in range(50, 60)), "with": "pos"})
    assert s.calls[1][0] == f"https://api.music.yandex.ru/tracks?{second}"


def test_album_with_tracks_falls_back_on_waf_403():
    # Yandex WAF 403s /with-tracks even for the owning token — fall back to plain /albums/{id}
    # + batched /tracks, and fill the id-only volume entries with the fetched tracks.
    stub = {"id": 555, "title": "Album", "volumes": [[{"id": 1}, {"id": 2, "title": "T2"}]]}
    full = [{"id": 1, "title": "T1", "durationMs": 100000, "artists": [{"name": "A"}]}, {"id": 2, "title": "T2"}]
    s = FakeSession([
        FakeResponse({}, status=403),                      # /albums/555/with-tracks — WAF
        FakeResponse({"result": stub}),                    # /albums/555
        FakeResponse({"result": full}),                    # /tracks
    ])
    album = _client_with(s).album_with_tracks("555")
    assert s.calls[0][0].endswith("/albums/555/with-tracks")
    assert s.calls[1][0].endswith("/albums/555")
    assert album["volumes"][0][0]["title"] == "T1"
    assert album["volumes"][0][1]["title"] == "T2"


def test_album_with_tracks_non_403_error_propagates():
    s = FakeSession([FakeResponse({}, status=500)])
    with pytest.raises(Exception, match="HTTP 500"):
        _client_with(s).album_with_tracks("555")


def test_proxy_goes_on_the_session():
    s = FakeSession()
    YandexClient(token=None, proxy="http://127.0.0.1:8080", session=s)
    assert s.proxies == {"http": "http://127.0.0.1:8080", "https": "http://127.0.0.1:8080"}


# ------------------------------------------------------------------ trackMeta

def test_track_meta_maps_the_raw_shape():
    m = track_meta({
        "id": 9, "realId": 99, "title": "Roxanne", "durationMs": 301000,
        "artists": [{"name": "The Police"}, {"name": None}],
        "albums": [{"title": "Outlandos d'Amour"}],
    })
    assert m == {
        "title": "Roxanne",
        "artists": ["The Police"],
        "album": "Outlandos d'Amour",
        "duration": 301,
        "sourceId": "99",
    }


def test_track_meta_falls_back_and_defaults():
    assert track_meta(None) is None
    assert track_meta({"error": "x"}) is None
    assert track_meta({"id": 5}) is None  # no title
    m = track_meta({"id": 5, "title": "T"})
    assert m["artists"] == ["Unknown"]
    assert m["album"] is None
    assert m["duration"] == 0
    assert m["sourceId"] == "5"


def test_track_meta_from_id():
    assert track_meta_from_id({"trackId": 7}) == "7"
    assert track_meta_from_id({"id": 8}) == "8"
    assert track_meta_from_id(9) == "9"
    assert track_meta_from_id(None) is None
