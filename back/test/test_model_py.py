"""Port of model-level behavior (no dedicated node test file — scenarios derived from
back-node-js/src/model.ts + its use in matcher/pipeline)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from model import artist_str, cache_key, match_usable  # noqa: E402


def _track(**over):
    t = {"title": "Daze", "artists": ["Poets Of The Fall"], "album": "Daze", "duration": 326, "sourceId": None}
    t.update(over)
    return t


def test_artist_str_joins_with_comma_space():
    assert artist_str(_track(artists=["The Struts", "Kesha"])) == "The Struts, Kesha"
    assert artist_str(_track(artists=["A"])) == "A"


def test_match_usable_truth_table():
    assert match_usable({"status": "matched", "score": 0.9, "videoId": "vid"})
    assert match_usable({"status": "uncertain", "score": 0.6, "videoId": "vid"})
    # matched/uncertain without a videoId is not usable
    assert not match_usable({"status": "matched", "score": 0.9, "videoId": None})
    assert not match_usable({"status": "matched", "score": 0.9})
    # the other statuses are answers, never links
    for status in ("not_found", "search_failed", "skipped_dup"):
        assert not match_usable({"status": status, "score": 0, "videoId": "vid"})


def test_cache_key_is_deterministic_and_versioned():
    a = cache_key(_track())
    b = cache_key({"title": "Daze", "artists": ["Poets Of The Fall"], "album": None, "duration": 326, "sourceId": "9:9"})
    assert a == b  # album/sourceId do not participate
    assert a != cache_key(_track(title="Daze "))
    assert a != cache_key(_track(duration=327))
    assert a != cache_key(_track(artists=["Other"]))
    # sha1 hex of "v<SCORE_VERSION>|title|artists|duration"
    import hashlib
    assert a == hashlib.sha1(b"v2|Daze|Poets Of The Fall|326").hexdigest()
