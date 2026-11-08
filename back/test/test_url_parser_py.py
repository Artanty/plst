"""Port of back-node-js/test/url.test.ts — scenarios 1:1."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from url_parser import from_form, parse_url  # noqa: E402


def test_parses_playlist_urls():
    t = parse_url("https://music.yandex.ru/users/someuser/playlists/12345")
    assert t["mode"] == "playlist"
    assert t["user"] == "someuser"
    assert t["kind"] == "12345"


def test_parses_liked_urls():
    t = parse_url("https://music.yandex.ru/users/someuser/playlists/liked")
    assert t["mode"] == "liked"
    assert t["user"] == "someuser"


def test_parses_album_urls():
    t = parse_url("https://music.yandex.ru/album/9876543/track/123")
    assert t["mode"] == "album"
    assert t["albumId"] == "9876543"


def test_supports_other_regional_domains():
    t = parse_url("https://music.yandex.uz/users/x/playlists/7")
    assert t["mode"] == "playlist"
    assert t["kind"] == "7"


def test_parses_shared_playlist_urls_lk_token():
    t = parse_url(
        "https://music.yandex.ru/playlists/lk.7c39432a-7d1d-47b3-8e81-9af76cad4e65"
        "?utm_source=web&utm_medium=copy_link",
    )
    assert t["mode"] == "playlist"
    assert t["shareToken"] == "lk.7c39432a-7d1d-47b3-8e81-9af76cad4e65"
    assert t["user"] is None


def test_rejects_unsupported_urls():
    with pytest.raises(ValueError, match="unsupported"):
        parse_url("https://example.com/x")


def test_from_form_extracts_username_from_pasted_url_in_user_modes():
    t = from_form("liked", "https://music.yandex.ru/users/vasya/playlists/liked")
    assert t["mode"] == "liked"
    assert t["user"] == "vasya"


def test_from_form_routes_pasted_track_json_without_trying_to_parse_a_yandex_url():
    t = from_form("json", '[{"title":"Daze","artists":["Poets Of The Fall"],"durationS":326}]')
    assert t["mode"] == "json"


def test_from_form_rejects_unknown_modes():
    with pytest.raises(ValueError, match="unknown mode"):
        from_form("nope", "x")
