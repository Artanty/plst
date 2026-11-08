"""Port of back-node-js/test/library.test.ts + library-users.test.ts — 1:1 scenarios.

The node suite gave every test a fresh schema; here the fixtures are session-scoped, so every
scenario is order-independent: unique names per test and delta assertions on global counts.
"""

import uuid

import pytest

from library.keys import song_dedup_key

TRACKS = [
    {"title": "Roxanne", "artists": ["The Police"], "album": "Outlandos", "durationS": 300},
    {"title": "Joanna", "artists": ["Kool G rap", "DJ Jazzy Jeff"], "album": None, "durationS": 214},
    {"title": "Ночной дозор", "artists": ["Кино"], "album": "Группа крови", "durationS": 258},
]


def _uniq(prefix):
    return f"{prefix} {uuid.uuid4().hex[:8]}"


def _song_total(library, **kw):
    return library.search_songs(**kw)["total"]


def _roxanne_seen_count(library):
    """seen_count of the shared TRACKS fixture's first song (0 if not imported yet)."""
    row = library.db.fetchone("SELECT seen_count FROM songs WHERE title=%(t)s", {"t": "Roxanne"})
    return int(row["seen_count"]) if row else 0


# --------------------------------------------------------------------- scan import


def test_scan_idempotent_same_scan_twice_creates_songs_once(library):
    seen_before = _roxanne_seen_count(library)
    total_before = _song_total(library)

    first = library.import_scan(1, TRACKS, source_label="p1")
    assert first["trackCount"] == 3
    assert first["newCount"] == 3

    second = library.import_scan(1, TRACKS, source_label="p2")
    # Two separate imports (you can scan the same playlist twice), but zero new SONGS.
    assert second["newCount"] == 0
    assert second["dupCount"] == 3
    assert second["importId"] != first["importId"]

    # No duplicate rows: the count grew by exactly the 3 fixture songs.
    assert _song_total(library) - total_before == 3

    song = next(r for r in library.search_songs(q="Roxanne")["rows"] if r["title"] == "Roxanne")
    # seen_count counts every scan that contained it; play_count the same. Neither is a duplicate row.
    assert song["seen_count"] == seen_before + 2


def test_dedups_inside_a_single_scan(library):
    res = library.import_scan(1, [TRACKS[0], TRACKS[0], TRACKS[0]], source_label="dup")
    assert res["trackCount"] == 1
    assert res["skippedCount"] == 2
    # Exactly one row for the repeated track — the DOM walk must not create duplicates.
    assert library.search_songs(q=TRACKS[0]["title"])["total"] == 1


def test_feat_order_and_comma_order_are_the_same_song(library):
    res = library.import_scan(
        1, [{"title": "Song", "artists": ["Alpha", "Beta"], "album": None, "durationS": 200}]
    )
    assert res["newCount"] == 1
    res2 = library.import_scan(
        1, [{"title": "Song", "artists": ["Beta", "Alpha"], "album": None, "durationS": 200}]
    )
    assert res2["newCount"] == 0
    assert song_dedup_key("Song", ["Beta", "Alpha"], 200) == song_dedup_key("Song", ["Alpha", "Beta"], 200)


def test_artists_are_rows_main_then_feat(library):
    library.import_scan(1, TRACKS)
    rows = library.search_songs(q="Joanna", limit=10, offset=0)["rows"]
    view = library.song_extras(rows)
    artists = view[rows[0]["id"]]["artists"]

    assert [a["name"] for a in artists] == ["Kool G rap", "DJ Jazzy Jeff"]
    assert [a["role"] for a in artists] == ["main", "feat"]


def test_albums_grouped_and_songs_attached(library):
    album_title = _uniq("Grouped Album")
    library.import_scan(
        1,
        [
            {"title": _uniq("AlSongA"), "artists": ["X"], "album": album_title, "durationS": 100},
            {"title": _uniq("AlSongB"), "artists": ["X"], "album": album_title, "durationS": 200},
        ],
    )
    albums = library.list_albums()
    album = next(a for a in albums if a["title"] == album_title)
    assert album["song_count"] == 2


def test_cross_user_scan_reuses_the_same_song_row(library):
    me = library.get_user(1)
    them = library.get_user(2)
    assert me
    assert them

    mine_pending = library.pending_import_count(me["id"])
    theirs_pending = library.pending_import_count(them["id"])
    total_before = _song_total(library)

    library.import_scan(me["id"], TRACKS, source_label="mine")
    second = library.import_scan(them["id"], TRACKS, source_label="theirs")

    assert second["newCount"] == 0
    assert _song_total(library) - total_before == 0
    # Each user still has their own pending import — the QUEUE is per user, the songs are global.
    assert library.pending_import_count(me["id"]) == mine_pending + 1
    assert library.pending_import_count(them["id"]) == theirs_pending + 1


def test_import_stays_pending_until_it_becomes_a_playlist(library):
    # Unique titles so all 3 are new songs of THIS import, whatever earlier tests scanned.
    tracks = [
        {"title": _uniq("PendSong"), "artists": ["Pend A"], "album": None, "durationS": t["durationS"]}
        for t in TRACKS
    ]
    pending_before = library.pending_import_count(1)
    res = library.import_scan(1, tracks, source_label="queue me")
    assert library.pending_import_count(1) == pending_before + 1
    total_after_import = _song_total(library)

    new_ids = library.import_new_song_ids(res["importId"])
    assert len(new_ids) == 3

    playlist_id = library.create_playlist(1, _uniq("From import"), None)
    library.add_playlist_items(playlist_id, new_ids, 1)
    library.mark_import_processed(res["importId"], playlist_id)

    assert library.pending_import_count(1) == pending_before
    items = library.playlist_item_rows(playlist_id)
    assert len(items) == 3
    # Songs survive the playlist they were built from.
    assert _song_total(library) - total_after_import == 0


def test_scan_order_kept_not_alphabetical(library):
    res = library.import_scan(1, TRACKS)
    ids = library.import_item_song_ids(res["importId"])
    playlist_id = library.create_playlist(1, _uniq("Ordered"), None)
    library.add_playlist_items(playlist_id, ids, 1)

    row_ids = [i["song_id"] for i in library.playlist_item_rows(playlist_id)]
    titles = [s["title"] for s in library.songs_by_ids(row_ids)]
    assert titles == ["Roxanne", "Joanna", "Ночной дозор"]


# --------------------------------------------- playlists, sharing and notifications


def _seeded(library):
    """The node suite's seeded() helper, with a unique playlist name per test."""
    res = library.import_scan(1, TRACKS, source_label="p")
    song_ids = library.import_new_song_ids(res["importId"])
    playlist_id = library.create_playlist(1, _uniq("Shared list"), None)
    library.add_playlist_items(playlist_id, song_ids, 1)
    return playlist_id, song_ids


def test_notifications_reach_every_other_participant_never_the_actor(library):
    playlist_id, _ = _seeded(library)
    edited_type = _uniq("edited")  # unique type = my rows only, even in a shared db
    shared_type = _uniq("shared")

    library.share_playlist(playlist_id, 2, True, 1)
    library.notify(2, shared_type, actor_id=1, playlist_id=playlist_id, payload={"canEdit": True})

    notified = library.notify_participants(
        playlist_id=playlist_id, actor_id=1, owner_id=1, type_=edited_type, payload={"action": "add", "count": 1}
    )
    assert notified == 1  # only user 2 — user 1 is the actor AND the owner

    for_two = [n for n in library.list_notifications(2) if n["type"] in (edited_type, shared_type)]
    assert [n["type"] for n in for_two] == [edited_type, shared_type]  # newest first

    # Now user 2 edits: the OWNER hears about it.
    library.notify_participants(playlist_id=playlist_id, actor_id=2, owner_id=1, type_=edited_type, payload={"action": "add"})
    for_one = [n for n in library.list_notifications(1) if n["type"] == edited_type]
    assert len(for_one) == 1
    assert for_one[0]["type"] == edited_type
    assert for_one[0]["actor_username"] == "zaur"


def test_shared_playlist_listed_with_can_edit_not_for_a_stranger(library):
    playlist_id, _ = _seeded(library)
    library.share_playlist(playlist_id, 2, True, 1)

    mine = [p for p in library.list_playlists_for_user(1) if p["id"] == playlist_id]
    assert len(mine) == 1
    assert mine[0]["shared_with_me"] is False
    assert mine[0]["can_edit"] is True  # owner

    shared = [p for p in library.list_playlists_for_user(2) if p["id"] == playlist_id]
    assert len(shared) == 1
    assert shared[0]["shared_with_me"] is True
    assert shared[0]["can_edit"] is True
    assert shared[0]["owner_username"] == "artyom"

    assert len([p for p in library.list_playlists_for_user(2) if p["id"] == playlist_id]) == 1
    library.share_playlist(playlist_id, 2, False, 1)
    view_only = [p for p in library.list_playlists_for_user(2) if p["id"] == playlist_id]
    assert view_only[0]["can_edit"] is False
    assert view_only[0]["shared_with_me"] is True


def test_view_only_collaborator_is_still_an_edit_participant(library):
    playlist_id, _ = _seeded(library)
    library.share_playlist(playlist_id, 2, False, 1)
    edited_type = _uniq("edited")
    notified = library.notify_participants(playlist_id=playlist_id, actor_id=1, owner_id=1, type_=edited_type)
    # They are still notified about changes — the requirement is that everyone's edits are seen,
    # regardless of who may make them.
    assert notified == 1


def test_deleting_a_playlist_keeps_every_song(library):
    total_before = _song_total(library)
    playlist_id, _ = _seeded(library)
    library.delete_playlist(playlist_id)
    assert library.get_playlist(playlist_id) is None
    assert library.playlist_item_rows(playlist_id) == []
    assert _song_total(library) - total_before == 0


def test_notifications_read_only_the_owner_of_the_notification(library):
    playlist_id, _ = _seeded(library)
    library.share_playlist(playlist_id, 2, True, 1)
    unread_two_before = library.unread_notification_count(2)
    unread_one_before = library.unread_notification_count(1)

    library.notify(2, "playlist_shared", actor_id=1, playlist_id=playlist_id)
    assert library.unread_notification_count(2) == unread_two_before + 1

    marked = library.mark_notifications_read(2, None)
    assert marked == unread_two_before + 1
    assert library.unread_notification_count(2) == 0
    # Only user 2's notifications were touched.
    assert library.unread_notification_count(1) == unread_one_before


def test_search_by_title_or_artist_and_album(library):
    _seeded(library)
    assert library.search_songs(q="rox", limit=50, offset=0)["total"] == 1
    # Substring, not prefix: a human remembers "Joanna", not "jo".
    assert library.search_songs(q="oa", limit=50, offset=0)["total"] == 1
    assert library.search_songs(q="Полиция", limit=50, offset=0)["total"] == 0
    assert library.search_songs(q="police", limit=50, offset=0)["total"] == 1  # case-insensitive

    albums = library.list_albums()
    outlandos = next(a for a in albums if a["title"] == "Outlandos")
    assert library.search_songs(album_id=outlandos["id"], limit=50, offset=0)["total"] == 1

    artists = library.list_artists()
    police = next(a for a in artists if a["name"] == "The Police")
    assert library.search_songs(artist_id=police["id"], limit=50, offset=0)["total"] == 1


def test_percent_and_underscore_in_search_are_literals(library):
    library.import_scan(
        1,
        [
            {"title": "100% Pure Love", "artists": ["A"], "album": None, "durationS": 100},
            {"title": "Ordinary Song", "artists": ["B"], "album": None, "durationS": 200},
            {"title": "a_b", "artists": ["C"], "album": None, "durationS": 300},
        ],
    )
    # The escape works precisely because it still FINDS the literal: one row has a % in the title.
    assert library.search_songs(q="100%", limit=50, offset=0)["total"] == 1
    assert library.search_songs(q="%", limit=50, offset=0)["total"] == 1
    # Unescaped, '%' and '_' would each match all three rows.
    assert library.search_songs(q="_", limit=50, offset=0)["total"] == 1
    assert library.search_songs(q="Pure", limit=50, offset=0)["total"] == 1
    # A backslash in the query itself must not become a live escape character.
    assert library.search_songs(q="\\%", limit=50, offset=0)["total"] == 0


def test_empty_genre_list_still_queryable(library):
    playlist_id, song_ids = _seeded(library)
    genres = library.list_genres()
    assert genres == []
    assert library.search_songs(genre_id=1, limit=50, offset=0)["total"] == 0
    # (len(song_ids) is 3 only on a fresh db — here TRACKS may already exist from earlier tests.)
    assert library.get_playlist(playlist_id) is not None
    assert library.get_playlist(playlist_id) is not None


# ------------------------------------------------------------------- route-level (HTTP)


def test_http_users_route(client):
    res = client.get("/api/library/users", headers={"x-user-id": "1"})
    assert res.status_code == 200
    body = res.get_json()
    names = {u["username"] for u in body["users"]}
    assert {"artyom", "zaur"} <= names
    assert all(set(u) == {"id", "username", "display_name"} for u in body["users"])


def test_http_scan_route_counts_and_pending(client, library):
    # How many of the fixture tracks are already in the library from earlier tests?
    existing = sum(
        1 for t in TRACKS if library.search_songs(q=t["title"], limit=50, offset=0)["total"] > 0
    )
    pending_before = library.pending_import_count(1)
    res = client.post(
        "/api/library/scan", json={"tracks": TRACKS, "label": "http scan"}, headers={"x-user-id": "1"}
    )
    assert res.status_code == 200
    body = res.get_json()
    assert set(body) == {"importId", "trackCount", "newCount", "dupCount", "skippedCount", "user", "pendingImports"}
    assert body["trackCount"] == 3
    assert body["newCount"] == 3 - existing
    assert body["dupCount"] == existing
    assert body["skippedCount"] == 0
    assert body["user"] == {"id": 1, "username": "artyom"}
    assert body["pendingImports"] == pending_before + 1

    # The same scan again: zero new songs, dupCount 3.
    res2 = client.post("/api/library/scan", json={"tracks": TRACKS}, headers={"x-user-id": "1"})
    assert res2.status_code == 200
    assert res2.get_json()["newCount"] == 0
    assert res2.get_json()["dupCount"] == 3
    assert res2.get_json()["importId"] != body["importId"]


def test_http_scan_errors_are_text_plain(client):
    # No header, no userId in body.
    res = client.post("/api/library/scan", json={"tracks": TRACKS})
    assert res.status_code == 400
    assert res.content_type.startswith("text/plain")
    assert res.data == b"userId must be a positive integer"

    # Unknown user.
    res = client.post("/api/library/scan", json={"tracks": TRACKS}, headers={"x-user-id": "999"})
    assert res.status_code == 404
    assert res.data == b"no user with id 999"

    # All rows missing a title.
    res = client.post("/api/library/scan", json={"tracks": [{"title": ""}, {"artists": ["X"]}]},
                      headers={"x-user-id": "1"})
    assert res.status_code == 400
    assert res.data == b"no usable rows: 2 in, all missing a title (2 skipped)"

    # Body that is not {tracks: [...]}.
    res = client.post("/api/library/scan", json={"nope": 1}, headers={"x-user-id": "1"})
    assert res.status_code == 400
    assert res.data == b"expected {tracks: [...]}"


def test_http_songs_route_shape(client, library):
    library.import_scan(1, TRACKS)
    res = client.get("/api/library/songs?q=roxanne", headers={"x-user-id": "1"})
    assert res.status_code == 200
    body = res.get_json()
    assert set(body) == {"total", "limit", "offset", "songs"}
    assert body["total"] == 1
    song = body["songs"][0]
    assert song["title"] == "Roxanne"
    assert [a["name"] for a in song["artists"]] == ["The Police"]
    assert song["genres"] == []
    assert song["album_title"] == "Outlandos"

    # Missing viewer header on a route that needs one.
    res = client.get("/api/library/songs")
    assert res.status_code == 400
    assert res.content_type.startswith("text/plain")
    assert res.data == b"x-user-id header must be a positive integer (there is no login yet)"


def test_http_import_pending_and_detail_ownership(client, library):
    res = client.post("/api/library/scan", json={"tracks": TRACKS}, headers={"x-user-id": "1"})
    import_id = res.get_json()["importId"]

    listing = client.get("/api/library/imports/pending", headers={"x-user-id": "1"})
    assert listing.status_code == 200
    assert any(i["id"] == import_id for i in listing.get_json()["imports"])

    detail = client.get(f"/api/library/imports/{import_id}", headers={"x-user-id": "1"})
    assert detail.status_code == 200
    body = detail.get_json()
    assert set(body) == {"import", "tracks"}
    assert len(body["tracks"]) == 3
    assert all("isNew" in t and "artists" in t for t in body["tracks"])

    # Someone else's import: 404 (not 403) — owner-only queue, sequential guessable ids.
    foreign = client.get(f"/api/library/imports/{import_id}", headers={"x-user-id": "2"})
    assert foreign.status_code == 404
    assert foreign.content_type.startswith("text/plain")
    assert foreign.data == b"import not found"


def test_http_import_to_playlist_and_delete_owner_only(client, library):
    # Unique titles: the import must have new songs so the default songIds (is_new=1) is all 3.
    tracks = [
        {"title": _uniq("HttpImportSong"), "artists": ["Http A"], "album": None, "durationS": t["durationS"]}
        for t in TRACKS
    ]
    pending_before = library.pending_import_count(1)
    res = client.post("/api/library/scan", json={"tracks": tracks}, headers={"x-user-id": "1"})
    import_id = res.get_json()["importId"]

    pending_before = library.pending_import_count(1)

    made = client.post(f"/api/library/imports/{import_id}/playlist",
                       json={"name": _uniq("Http import playlist")}, headers={"x-user-id": "1"})
    assert made.status_code == 200
    body = made.get_json()
    assert set(body) == {"playlistId", "importId", "trackCount"}
    assert body["trackCount"] == 3
    playlist_id = body["playlistId"]

    # The import is no longer pending.
    assert library.get_import(import_id)["is_processed"] == 1
    assert library.pending_import_count(1) == pending_before - 1

    # Only the owner deletes: user 2 is not even a viewer here.
    denied = client.delete(f"/api/library/playlists/{playlist_id}", headers={"x-user-id": "2"})
    assert denied.status_code == 403
    assert denied.data == b"only the owner can delete this playlist"

    deleted = client.delete(f"/api/library/playlists/{playlist_id}", headers={"x-user-id": "1"})
    assert deleted.status_code == 200
    assert deleted.get_json() == {"ok": True, "deletedPlaylist": playlist_id}
    assert library.get_playlist(playlist_id) is None


def test_http_share_route_and_notifications(client, library):
    playlist_id = library.create_playlist(1, _uniq("Http shared"), None)

    # Non-owner cannot share.
    forbidden = client.post(f"/api/library/playlists/{playlist_id}/share",
                            json={"userId": 2, "canEdit": True}, headers={"x-user-id": "2"})
    assert forbidden.status_code == 403
    assert forbidden.data == b"only the owner can share this playlist"

    ok = client.post(f"/api/library/playlists/{playlist_id}/share",
                     json={"userId": 2, "canEdit": True}, headers={"x-user-id": "1"})
    assert ok.status_code == 200
    body = ok.get_json()
    assert body == {"playlistId": playlist_id,
                    "sharedWith": {"id": 2, "username": "zaur"}, "canEdit": True}

    playlists = client.get("/api/library/playlists", headers={"x-user-id": "2"}).get_json()
    mine = [p for p in playlists["shared"] if p["id"] == playlist_id]
    assert len(mine) == 1 and mine[0]["can_edit"] is True and mine[0]["shared_with_me"] is True

    notif = client.get("/api/library/notifications", headers={"x-user-id": "2"}).get_json()
    assert set(notif) == {"notifications", "unread", "pendingImports"}
    assert any(n["type"] == "playlist_shared" and n["playlist_id"] == playlist_id
               for n in notif["notifications"])

    # Unshare: notify + gone from the recipient's shared list.
    unshare = client.delete(f"/api/library/playlists/{playlist_id}/share/2", headers={"x-user-id": "1"})
    assert unshare.status_code == 200
    assert unshare.get_json() == {"ok": True}
    after = [p for p in client.get("/api/library/playlists", headers={"x-user-id": "2"}).get_json()["shared"]
             if p["id"] == playlist_id]
    assert after == []


def test_http_me_endpoint(client, library):
    me = client.get("/api/library/me", headers={"x-user-id": "1"})
    assert me.status_code == 200
    body = me.get_json()
    assert set(body) == {"user", "pendingImports", "unreadNotifications", "myPlaylists",
                         "sharedWithMe", "librarySongs"}
    assert body["user"]["username"] == "artyom"
