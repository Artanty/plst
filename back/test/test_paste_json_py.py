"""Port of back-node-js/test/pasteJson.test.ts — scenarios 1:1."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from paste_json import parse_track_json  # noqa: E402


def test_maps_the_browser_extension_shape_onto_track_meta():
    out = parse_track_json(json.dumps([
        {"title": "Daze", "artists": ["Poets Of The Fall"], "album": "Daze", "durationS": 326},
        {"title": "Body Talks", "artists": ["The Struts", "Kesha"], "album": None, "durationS": 177},
    ]))
    assert out["skipped"] == 0
    assert out["tracks"][0] == {
        "title": "Daze",
        "artists": ["Poets Of The Fall"],
        "album": "Daze",
        "duration": 326,
        "sourceId": None,
    }
    assert out["tracks"][1]["artists"] == ["The Struts", "Kesha"]
    assert out["tracks"][1]["album"] is None


def test_accepts_an_object_wrapper_and_a_single_artist_string():
    out = parse_track_json(json.dumps(
        {"tracks": [{"title": "Paradise", "artists": "Marc Martel", "durationS": "251"}]},
    ))
    assert out["tracks"][0]["artists"] == ["Marc Martel"]
    assert out["tracks"][0]["duration"] == 251


def test_skips_rows_with_no_title_and_reports_the_count():
    out = parse_track_json(json.dumps([
        {"title": "  "},
        {"artists": ["x"]},
        {"title": "Real", "artists": ["A"]},
    ]))
    assert out["skipped"] == 2
    assert len(out["tracks"]) == 1
    assert out["tracks"][0]["title"] == "Real"


def test_defaults_missing_artists_and_a_bad_duration_instead_of_failing_the_run():
    out = parse_track_json(json.dumps([{"title": "No Meta", "durationS": "n/a"}]))
    assert out["tracks"][0]["artists"] == ["Unknown"]
    assert out["tracks"][0]["duration"] == 0


def test_rejects_input_that_cannot_yield_a_track():
    with pytest.raises(ValueError, match="not valid JSON"):
        parse_track_json("not json")
    with pytest.raises(ValueError, match="tracks"):
        parse_track_json('{"a":1}')
    with pytest.raises(ValueError, match="no usable rows"):
        parse_track_json("[]")
