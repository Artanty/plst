"""Ports of back-node-js/test/matcher.test.ts (pure matcher) and the non-DB part of
library-youtube.test.ts (matchSong/matchSongs/export). Everything runs against a FAKE search —
no network, no MySQL.
"""
import pytest

from config import settings
from matcher import build_queries, duration_ok, match_track, normalize, transliterate
from library.match import (
    is_confident,
    match_song,
    match_songs,
    match_usable,
    search_failure_reason,
)
from library.youtube import build_youtube_export, yt_url


def meta(title, artists, duration):
    return {"title": title, "artists": artists, "album": None, "duration": duration, "sourceId": None}


def cand(video_id, title, artists, duration):
    return {"videoId": video_id, "title": title, "artists": artists, "duration": duration}


# ------------------------------------------------------------------ matcher (matcher.test.ts)

def test_normalize_strips_brackets_and_noise():
    assert normalize("Bohemian Rhapsody (1991 Remaster)") == "bohemian rhapsody"
    assert normalize("Song — Official Video [HQ]") == "song"


def test_transliterate_cyrillic_to_latin():
    assert transliterate("Звезда по имени Солнце") == "zvezda po imeni solntse"


def test_transliterate_leaves_latin_alone():
    assert transliterate("Plain Title") == "Plain Title"


def test_duration_ok_tolerates_small_differences():
    assert duration_ok(100, 103, 5) is True


def test_duration_ok_rejects_big_differences():
    assert duration_ok(100, 200, 5) is False


def test_duration_ok_null_for_missing_data():
    assert duration_ok(None, 100, 5) is None


def test_match_track_accepts_a_good_match():
    res = match_track(meta("Bohemian Rhapsody", ["Queen"], 355), [
        cand("vid1", "Bohemian Rhapsody (Remaster 2011)", "Queen", 355),
    ])
    assert res["status"] == "matched"
    assert res["videoId"] == "vid1"


def test_match_track_rejects_wrong_duration():
    res = match_track(meta("Hotel California", ["Eagles"], 390), [
        cand("vid2", "Hotel California", "Eagles", 120),
    ])
    assert res["status"] in ("uncertain", "not_found")


def test_match_track_prefers_the_studio_cut_over_a_same_title_remix():
    track = meta("I Don't Feel Like Dancin'", ["Scissor Sisters"], 287)
    remix = cand("bad", "I Don't Feel Like Dancin' (Teenage Bad Girl Remix)", "Scissor Sisters", 284)
    real = cand("good", "I Don't Feel Like Dancin'", "Scissor Sisters", 289)
    res = match_track(track, [remix, real])
    assert res["videoId"] == "good"
    assert res["status"] == "matched"


def test_match_track_does_not_penalize_a_remaster():
    res = match_track(meta("Bohemian Rhapsody", ["Queen"], 355), [
        cand("v", "Bohemian Rhapsody (Remastered 2011)", "Queen", 355),
    ])
    assert res["score"] == pytest.approx(1.0)


def test_match_track_handles_empty_candidates():
    res = match_track(meta("Nothing", ["Nobody"], 200), [])
    assert res["status"] == "not_found"


def test_build_queries_produces_artist_first_and_transliterated_variants():
    qs = build_queries(meta("Звезда", ["Кино"], 200))
    assert qs[0] == "Кино Звезда"
    assert any(("Kino" in q) or ("kino" in q) or ("Zvezda" in q) for q in qs)


# ------------------------------------------------- matchSong / matchSongs (library-youtube)

CANDIDATES = [
    {"videoId": "aaaaaaaaaaa", "title": "Roxanne", "artists": "The Police", "duration": 301},
    {"videoId": "bbbbbbbbbbb", "title": "Roxanne (Live)", "artists": "The Police", "duration": 320},
    {"videoId": "ccccccccccc", "title": "De Do Do Do", "artists": "The Police", "duration": 210},
]


class FakeSearch:
    """Port of the node fakeDeps: records queries, returns CANDIDATES."""

    def __init__(self):
        self.searched = []

    def __call__(self, query):
        self.searched.append(query)
        return CANDIDATES


def song(**over):
    base = {
        "id": 1,
        "title": "Roxanne",
        "artists": ["The Police"],
        "album": "Outlandos",
        "duration": 300,
        "yt_video_id": None,
        "match_score": None,
    }
    base.update(over)
    return base


def test_match_song_finds_the_right_video_and_reports_the_score():
    fake = FakeSearch()
    res = match_song(song(), fake)
    assert res["status"] == "matched"
    assert res["videoId"] == "aaaaaaaaaaa"
    assert len(fake.searched) > 0


def test_match_song_reports_search_failed_with_the_cause_never_not_found():
    # The live bug, 2026-10-19: YTM_PROXY pointed at a stopped local proxy, every query threw
    # ECONNREFUSED, and the UI said all tracks were "not in the catalog". A dead search is not
    # an answer about the song.
    def dead(query):
        raise Exception("connect ECONNREFUSED 127.0.0.1:8080")

    res = match_song(song(), dead)
    assert res["status"] == "search_failed"
    assert res["videoId"] is None
    assert "ECONNREFUSED" in res["reason"]


def test_search_failure_reason_names_ytm_proxy_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "ytm_proxy", "http://127.0.0.1:8080")
    reason = search_failure_reason(Exception("connect ECONNREFUSED 127.0.0.1:8080\n    at ..."))
    assert reason.startswith("connect ECONNREFUSED 127.0.0.1:8080")
    assert f"YTM_PROXY=http://127.0.0.1:8080" in reason
    assert reason.endswith("is that proxy running?")


def test_search_failure_reason_bare_when_no_proxy(monkeypatch):
    monkeypatch.setattr(settings, "ytm_proxy", None)
    assert search_failure_reason(Exception("connect ETIMEDOUT")) == "connect ETIMEDOUT"


def test_match_song_still_returns_not_found_when_search_answers_nothing():
    res = match_song(song(title="Zzzz No Such Song Anywhere"), lambda query: [])
    assert res["status"] == "not_found"
    assert res["videoId"] is None


def test_match_songs_counts_search_failed_apart_from_not_found():
    # A batch where one song's search dies and another comes back empty: the two failures must
    # stay distinguishable.
    def partial(query):
        if "Crawling" in query:
            raise Exception("connect ETIMEDOUT")
        return []

    res = match_songs([song(id=1, title="Crawling"), song(id=2, title="Faint")], partial)
    by_id = {r["songId"]: r for r in res}
    assert by_id[1]["status"] == "search_failed"
    assert "ETIMEDOUT" in by_id[1]["reason"]
    assert by_id[2]["status"] == "not_found"


def test_match_song_does_not_search_again_for_an_already_matched_song():
    fake = FakeSearch()
    res = match_song(song(yt_video_id="keepthisone"), fake)
    assert res == {"status": "matched", "score": 0, "videoId": "keepthisone"}
    assert fake.searched == []


def test_match_songs_matches_a_batch_and_keeps_every_song():
    fake = FakeSearch()
    res = match_songs([song(id=1), song(id=2), song(id=3)], fake)
    assert len(res) == 3
    assert all(r["songId"] > 0 for r in res)
    assert all(r["error"] is None for r in res)


def test_match_usable_semantics():
    assert match_usable({"status": "matched", "videoId": "v"})
    assert match_usable({"status": "uncertain", "videoId": "v"})
    assert not match_usable({"status": "uncertain", "videoId": None})
    assert not match_usable({"status": "not_found", "videoId": "v"})
    assert not match_usable({"status": "search_failed", "videoId": None})


def test_is_confident_uses_the_accept_threshold(monkeypatch):
    monkeypatch.setattr(settings, "match_accept", 0.75)
    assert is_confident(0.75)
    assert is_confident(1.0)
    assert not is_confident(0.568)
    assert not is_confident(None)


# ------------------------------------------------------------------- export

def test_export_renders_one_link_per_confidently_matched_song():
    report = build_youtube_export([
        song(id=1, yt_video_id="aaaaaaaaaaa", match_score=1),
        song(id=2, title="De Do Do Do", yt_video_id="ccccccccccc", match_score=0.9),
    ])
    assert report["matched"] == 2
    assert report["total"] == 2
    assert [l["url"] for l in report["links"]] == [yt_url("aaaaaaaaaaa"), yt_url("ccccccccccc")]
    assert "#" not in report["text"]


def test_export_does_not_paste_an_uncertain_match_as_a_link():
    # Verified live: a Yandex "Roxanne" (with a wrong duration) was matched to
    # "Message In A Bottle - The Police" at 0.57.
    report = build_youtube_export([song(id=1, yt_video_id="wrongrap", match_score=0.568)])
    assert report["matched"] == 0
    assert report["links"] == []
    assert len(report["uncertain"]) == 1
    assert report["uncertain"][0]["url"] == yt_url("wrongrap")
    assert "#" in report["text"]
    assert "uncertain" in report["text"]
    assert all(line.startswith("#") for line in report["text"].split("\n"))


def test_export_treats_a_stored_match_with_no_score_as_uncertain():
    report = build_youtube_export([song(id=1, yt_video_id="unknownscore", match_score=None)])
    assert report["links"] == []
    assert len(report["uncertain"]) == 1


def test_export_names_the_unmatched_songs_instead_of_dropping_them():
    report = build_youtube_export([
        song(id=1, yt_video_id="aaaaaaaaaaa", match_score=1),
        song(id=2, title="Lost Song"),
    ])
    assert report["matched"] == 1
    assert report["total"] == 2
    assert report["unmatched"] == [{"songId": 2, "title": "Lost Song", "artists": ["The Police"]}]
    assert "Lost Song" in report["text"]
    assert "1 of 2 songs" in report["text"]


def test_export_lists_search_failed_songs_separately():
    # One list says "retry after fixing the network", the other says "don't bother retrying".
    report = build_youtube_export([
        song(id=1, title="Never Searched", match_status="search_failed"),
        song(id=2, title="Genuinely Absent", match_status="not_found"),
    ])
    assert report["searchFailed"] == [{"songId": 1, "title": "Never Searched", "artists": ["The Police"]}]
    assert report["unmatched"] == [{"songId": 2, "title": "Genuinely Absent", "artists": ["The Police"]}]
    assert "Never Searched" in report["text"]
    assert "Genuinely Absent" in report["text"]
    assert "never searched" in report["text"]
    assert "YTM_PROXY" in report["text"]


def test_export_handles_an_empty_selection():
    report = build_youtube_export([])
    assert report["matched"] == 0
    assert report["total"] == 0
    assert report["text"] == ""
