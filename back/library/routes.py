"""Library routes — port of back-node-js/src/library/routes.ts.

Same routes, same status codes, same text/plain error bodies, same JSON shapes. `match_deps`
and `yandex_deps` are injected for tests (this machine cannot reach YouTube; the listen lookup
must be testable without Yandex being reachable).
"""
from flask import Blueprint, jsonify, request

from config import settings  # noqa: F401 (parity: node imported settings for num()/clamps)
from lib.ext_log import (  # vendored from feat (logging feature)
    MAX_ENTRIES_PER_REQUEST,
    ingest_ext_logs,
    normalize_ext_entries,
    read_ext_logs,
)
from lib.logger import logger

LIBRARY_PREFIX = "/api/library"
MAX_PAGE = 500
# A playlist match fans out into one YouTube search per song — capped per request.
MAX_PLAYLIST_MATCH = 50


class HttpError(Exception):
    """An HTTP error whose body is the message, text/plain (parity of node's HttpError)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def register_library_routes(app, store, match_deps=None, yandex_deps=None, poll_stats=None):
    """Attach every /api/library route to the Flask app.

    match_deps/yandex_deps: injectable for tests; None = the real clients. poll_stats:
    optional callable returning {skipPoll, skippedPolls, loggedRequests} so the logs endpoint
    can explain a quiet log (parity of node's app.skipPollStats()).
    """
    # The python port injects callables (node injected {searchSongs}/{searchTrack} dicts);
    # accept BOTH shapes so tests can pass either.
    def _search_fn(deps, import_path: str):
        if deps is None:
            module_path, name = import_path.rsplit(".", 1)
            import importlib

            return getattr(importlib.import_module(module_path), name)
        if isinstance(deps, dict):
            return deps["searchSongs"] if "searchSongs" in deps else deps["searchTrack"]
        return deps

    search_songs_dep = _search_fn(match_deps, "library.match._default_search")
    search_track_dep = _search_fn(yandex_deps, "library.yandex.default_search_track")
    bp = Blueprint("library", __name__)

    # ------------------------------------------------------------------ auth (one header)

    def viewer():
        raw = request.headers.get("x-user-id")
        try:
            user_id = int(raw) if raw is not None and str(raw).strip() != "" else None
        except ValueError:
            user_id = None
        if user_id is None or user_id <= 0:
            raise HttpError(400, "x-user-id header must be a positive integer (there is no login yet)")
        user = store.get_user(user_id)
        if not user:
            raise HttpError(404, f"no user with id {user_id}")
        return {"id": user["id"], "username": user["username"], "display_name": user["display_name"]}

    # ------------------------------------------------------ permission rules (the only ones)

    def assert_can_edit(playlist, user_id):
        if playlist["owner_id"] == user_id:
            return
        collabs = store.list_collaborators(playlist["id"])
        me = next((c for c in collabs if c["user_id"] == user_id), None)
        if not me:
            logger.warn("library: edit denied, not a collaborator", {"playlistId": playlist["id"], "userId": user_id})
            raise HttpError(404, "playlist not found")
        if not me["can_edit"]:
            logger.warn("library: edit denied, view-only", {"playlistId": playlist["id"], "userId": user_id})
            raise HttpError(403, "you have view-only access to this playlist")

    def assert_can_view(playlist, user_id):
        if playlist["owner_id"] == user_id:
            return
        collabs = store.list_collaborators(playlist["id"])
        if not any(c["user_id"] == user_id for c in collabs):
            raise HttpError(404, "playlist not found")

    def must_get_playlist(playlist_id):
        playlist = store.get_playlist(playlist_id)
        if not playlist:
            raise HttpError(404, "playlist not found")
        return playlist

    # ------------------------------------------------------------------ param helpers

    def int_param(value, name):
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise HttpError(400, f"{name} must be a positive integer")
        if n <= 0:
            raise HttpError(400, f"{name} must be a positive integer")
        return n

    def optional_int_param(value, name):
        if value is None or value == "":
            return None
        return int_param(value, name)

    def num(value, fallback=0):
        try:
            n = float(value)
        except (TypeError, ValueError):
            return fallback
        return n if n == n else fallback  # NaN -> fallback

    def body_json():
        return request.get_json(silent=True) or {}

    # Tracks are whatever shape the scan produced — the extension sends {artists: [...]}.
    def read_tracks(body):
        rows = body if isinstance(body, list) else (body or {}).get("tracks")
        if not isinstance(rows, list):
            raise HttpError(400, "expected {tracks: [...]}")
        if len(rows) > 5000:
            raise HttpError(413, f"refusing {len(rows)} tracks in one scan (max 5000)")
        out = []
        skipped = 0
        for row in rows:
            row = row or {}
            title = str(row.get("title") or "").strip()
            if not title:
                skipped += 1
                continue
            raw_artists = row.get("artists")
            if isinstance(raw_artists, list):
                artists = [str(a or "").strip() for a in raw_artists]
                artists = [a for a in artists if a]
            else:
                artists = [s.strip() for s in str(raw_artists or "").split(",") if s.strip()]
            out.append({
                "title": title,
                "artists": artists,
                "album": str(row.get("album") or "").strip() or None,
                "durationS": max(0, round(num(row.get("durationS"), 0))),
            })
        if not out:
            raise HttpError(400, f"no usable rows: {len(rows)} in, all missing a title ({skipped} skipped)")
        return out

    def to_song_views(songs):
        extras = store.song_extras(songs)
        views = []
        for s in songs:
            e = extras.get(s["id"], {})
            v = dict(s)
            v["artists"] = e.get("artists", [])
            v["genres"] = e.get("genres", [])
            v["album_title"] = e.get("album_title")
            views.append(v)
        return views

    def num_clamp(value, default, low, high):
        return min(max(num(value, default), low), high)

    # ------------------------------------------------------------------------- routes

    @bp.get(f"{LIBRARY_PREFIX}/healthz")
    def library_healthz():
        from library.genre import NULL_GENRE_PROVIDER

        return jsonify({"ok": True, "genreProvider": NULL_GENRE_PROVIDER.name, "note": "no login yet: send x-user-id"})

    @bp.get(f"{LIBRARY_PREFIX}/users")
    def users():
        return jsonify({"users": store.list_users()})

    # --------------------------------------------------------------------------- logs

    @bp.get(f"{LIBRARY_PREFIX}/logs")
    def logs():
        q = request.args
        last = num_clamp(q.get("last", 100), 100, 1, 1000)
        type_ = q.get("type") if q.get("type") in ("error", "app") else "all"
        entries = logger.get_logs(last=int(last), type_=type_, memory=q.get("source") == "memory", hide_sensitive=True)
        return jsonify({
            "source": "memory" if q.get("source") == "memory" else "files",
            "logDir": __import__("os").environ.get("LOG_DIR") or "logs",
            "fileWriting": __import__("os").environ.get("LOG_DISABLED") != "true",
            "count": len(entries),
            "requestLogging": poll_stats() if poll_stats else None,
            "entries": entries,
        })

    @bp.post(f"{LIBRARY_PREFIX}/ext-logs")
    def ext_logs_post():
        body = body_json()
        extension_id = body.get("extensionId")[:64] if isinstance(body.get("extensionId"), str) else None

        # Prefer the header (consistent with every other route); the body field is for the
        # extension, whose fetch calls have no header interceptor.
        user_id = None
        if request.headers.get("x-user-id") is not None:
            user_id = viewer()["id"]
        elif body.get("userId") is not None:
            user_id = int_param(body.get("userId"), "userId")
            # A stale extension user id is not a reason to drop the trace.
            if not store.get_user(user_id):
                user_id = None

        if "entries" not in body:
            raise HttpError(400, "entries is required (array of {ts, level, scope, msg})")
        normalized = normalize_ext_entries(body.get("entries"))
        ingest_ext_logs(normalized, {"extensionId": extension_id, "userId": user_id})

        received = len(body.get("entries")) if isinstance(body.get("entries"), list) else 0
        logger.log("ext logs ingested", {
            "received": received,
            "stored": len(normalized["entries"]),
            "dropped": normalized["dropped"],
            "capped": normalized["capped"] or None,
            "extensionId": extension_id,
            "userId": user_id,
        }, "ext-logs")

        res = {
            "ok": True,
            "received": received,
            "stored": len(normalized["entries"]),
            "dropped": normalized["dropped"],
            "capped": normalized["capped"],
        }
        if normalized["capped"]:
            res["note"] = f"kept the newest {MAX_ENTRIES_PER_REQUEST} of a larger batch"
        return jsonify(res)

    @bp.get(f"{LIBRARY_PREFIX}/ext-logs")
    def ext_logs_get():
        q = request.args
        last = num_clamp(q.get("last", 100), 100, 1, 1000)
        all_entries = read_ext_logs()
        level = q.get("level")
        extension_id = q.get("extensionId") or None
        user_id = int_param(q.get("userId"), "userId") if q.get("userId") else None
        filtered = []
        for e in all_entries:
            if level and e.get("level") != level:
                continue
            if extension_id or user_id is not None:
                d = e.get("data") or {}
                if extension_id and str(d.get("extensionId") or "") != extension_id:
                    continue
                if user_id is not None and int(d.get("userId") or 0) != user_id:
                    continue
            filtered.append(e)
        return jsonify({
            "source": "ext.log",
            "logDir": __import__("os").environ.get("LOG_DIR") or "logs",
            "fileWriting": __import__("os").environ.get("LOG_DISABLED") != "true",
            "count": min(len(filtered), int(last)),
            "totalInFile": len(all_entries),
            "matchedInFile": len(filtered),
            "entries": filtered[-int(last):],
        })

    # --------------------------------------------------------------------------- scan

    @bp.post(f"{LIBRARY_PREFIX}/scan")
    def scan():
        body = body_json()
        header_id = request.headers.get("x-user-id")
        header_user = viewer() if header_id is not None else None
        user_id = int_param(header_user["id"] if header_user else body.get("userId"), "userId")
        user = store.get_user(user_id)
        if not user:
            raise HttpError(404, f"no user with id {user_id}")

        try:
            tracks = read_tracks(request.get_json(silent=True))
        except HttpError as err:
            # The single most useful line when the user says "it did nothing".
            raw_tracks = (request.get_json(silent=True) or {}).get("tracks")
            logger.warn("library: scan rejected", {
                "userId": user_id,
                "rawCount": len(raw_tracks) if isinstance(raw_tracks, list) else None,
                "reason": err.message,
            })
            raise
        label = str(body.get("label") or "").strip() or None
        page_url = str(body.get("pageUrl") or "").strip() or None

        res = store.import_scan(user_id, tracks, source_label=label, page_url=page_url)
        logger.log("library: scan accepted", {
            "importId": res["importId"], "user": user["username"], "tracksIn": len(tracks),
            "newCount": res["newCount"], "dupCount": res["dupCount"], "skippedCount": res["skippedCount"],
            "label": label, "pageUrl": page_url,
        })
        return jsonify({
            **res,
            "user": {"id": user["id"], "username": user["username"]},
            "pendingImports": store.pending_import_count(user_id),
        })

    # ------------------------------------------------------------------------ imports

    @bp.get(f"{LIBRARY_PREFIX}/imports/pending")
    def imports_pending():
        me = viewer()
        return jsonify({"imports": store.pending_imports(me["id"])})

    @bp.get(f"{LIBRARY_PREFIX}/imports/<int:import_id>")
    def import_detail(import_id):
        me = viewer()
        row = store.get_import(import_id)
        # 404 (not 403) for someone else's import: owner-only queue, sequential guessable ids.
        if not row or row["user_id"] != me["id"]:
            raise HttpError(404, "import not found")
        song_ids = store.import_item_song_ids(import_id)
        ordered = store.songs_by_ids(song_ids)
        new_ids = set(store.import_new_song_ids(import_id))
        tracks = [{**v, "isNew": v["id"] in new_ids} for v in to_song_views(ordered)]
        return jsonify({"import": row, "tracks": tracks})

    @bp.post(f"{LIBRARY_PREFIX}/imports/<int:import_id>/playlist")
    def import_to_playlist(import_id):
        me = viewer()
        row = store.get_import(import_id)
        if not row or row["user_id"] != me["id"]:
            raise HttpError(404, "import not found")
        body = body_json()
        if isinstance(body.get("songIds"), list) and body["songIds"]:
            song_ids = [int_param(v, "songIds[]") for v in body["songIds"]]
        else:
            song_ids = store.import_new_song_ids(import_id)

        exist = store.existing_song_ids(song_ids)
        missing = [s for s in song_ids if s not in exist]
        if missing:
            raise HttpError(400, f"unknown song id(s): {', '.join(str(s) for s in missing)}")
        from_import = set(store.import_item_song_ids(import_id))
        foreign = [s for s in song_ids if s not in from_import]
        if foreign:
            raise HttpError(400, f"song id(s) not part of import {import_id}: {', '.join(str(s) for s in foreign)}")

        name = str(body.get("name") or "").strip() or f"{row['source_label'] or 'Imported'} ({row['track_count']} tracks)"
        playlist_id = store.create_playlist(me["id"], name, str(body.get("description") or "").strip() or None)
        store.add_playlist_items(playlist_id, song_ids, me["id"])
        store.mark_import_processed(import_id, playlist_id)
        logger.log("library: import turned into playlist", {
            "importId": import_id, "playlistId": playlist_id, "user": me["username"],
            "songs": len(song_ids), "name": name,
        })
        return jsonify({"playlistId": playlist_id, "importId": import_id, "trackCount": len(song_ids)})

    # ------------------------------------------------------------------------- songs

    @bp.get(f"{LIBRARY_PREFIX}/songs")
    def songs_list():
        viewer()
        q = request.args
        limit = num_clamp(q.get("limit", 50), 50, 1, MAX_PAGE)
        offset = max(num(q.get("offset", 0), 0), 0)
        result = store.search_songs(
            q=q.get("q"),
            album_id=optional_int_param(q.get("albumId"), "albumId"),
            artist_id=optional_int_param(q.get("artistId"), "artistId"),
            genre_id=optional_int_param(q.get("genreId"), "genreId"),
            limit=int(limit),
            offset=int(offset),
        )
        return jsonify({"total": result["total"], "limit": int(limit), "offset": int(offset),
                        "songs": to_song_views(result["rows"])})

    @bp.get(f"{LIBRARY_PREFIX}/songs/<int:song_id>")
    def song_detail(song_id):
        viewer()
        song = store.get_song(song_id)
        if not song:
            raise HttpError(404, "song not found")
        return jsonify({"song": to_song_views([song])[0]})

    # ---------------------------------------------------------------- listen (yandex)

    @bp.get(f"{LIBRARY_PREFIX}/songs/<int:song_id>/yandex")
    def song_yandex(song_id):
        viewer()
        songs = store.matchable_songs([song_id])
        if not songs:
            raise HttpError(404, "song not found")
        song = songs[0]
        from library.yandex import find_track_url

        try:
            ref = find_track_url(song, search_track=search_track_dep)
        except Exception as err:
            logger.error("library: yandex search failed", err, "songYandex")
            raise HttpError(502, f"yandex music search failed: {err}")
        if not ref:
            raise HttpError(404, f'no yandex music match for "{song["title"]}"')
        return jsonify({"songId": song_id, **ref})

    # ---------------------------------------------------------------- youtube matching

    @bp.post(f"{LIBRARY_PREFIX}/songs/<int:song_id>/match")
    def song_match(song_id):
        viewer()
        songs = store.matchable_songs([song_id])
        if not songs:
            raise HttpError(404, "song not found")
        song = songs[0]
        from library.match import match_song

        res = match_song(song, search_songs=search_songs_dep)
        # not_found is stored too (records that we tried); search_failed stored as itself.
        store.set_song_match(song["id"], res.get("videoId"), res["score"], res["status"])
        logger.log("library: song matched", {
            "songId": song["id"], "title": song["title"], "status": res["status"],
            "score": round(res["score"], 3), "videoId": res.get("videoId"), "reason": res.get("reason"),
        }, "matchSong")
        return jsonify({"songId": song["id"], **res})

    @bp.post(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>/match")
    def playlist_match(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        assert_can_view(playlist, me["id"])

        from library.match import match_songs

        songs = store.playlist_songs_for_links(playlist_id)
        if len(songs) > MAX_PLAYLIST_MATCH:
            raise HttpError(400, f"playlist has {len(songs)} songs; match at most {MAX_PLAYLIST_MATCH} per request")
        results = match_songs(songs, search_songs=search_songs_dep)
        for r in results:
            store.set_song_match(r["songId"], r.get("videoId"), r["score"], r["status"])

        matched = sum(1 for r in results if r["status"] in ("matched", "uncertain"))
        search_failed = sum(1 for r in results if r["status"] == "search_failed")
        logger.log("library: playlist matched", {
            "playlistId": playlist_id, "user": me["username"], "songs": len(results),
            "matched": matched, "searchFailed": search_failed,
        }, "matchPlaylist")
        return jsonify({"playlistId": playlist_id, "total": len(results), "matched": matched,
                        "searchFailed": search_failed, "results": results})

    @bp.get(f"{LIBRARY_PREFIX}/export/youtube")
    def export_youtube():
        me = viewer()
        from library.youtube import build_youtube_export

        q = request.args
        if q.get("playlistId"):
            playlist_id = int_param(q.get("playlistId"), "playlistId")
            playlist = must_get_playlist(playlist_id)
            assert_can_view(playlist, me["id"])
            songs = store.playlist_songs_for_links(playlist_id)
        elif q.get("songIds"):
            ids = [int_param(v.strip(), "songIds") for v in q.get("songIds").split(",") if v.strip()]
            if not ids:
                raise HttpError(400, "pass playlistId or songIds")
            songs = store.matchable_songs(ids)
        else:
            raise HttpError(400, "pass playlistId or songIds")

        report = build_youtube_export(songs)
        logger.log("library: youtube export", {
            "user": me["username"], "playlistId": q.get("playlistId"), "songs": report["total"],
            "matched": report["matched"], "unmatched": len(report["unmatched"]),
            "searchFailed": len(report["searchFailed"]),
        }, "exportYoutube")

        if q.get("format") == "text":
            text = report["text"] if report["text"].endswith("\n") else report["text"] + "\n"
            return (text, 200, {"Content-Type": "text/plain; charset=utf-8"})
        return jsonify(report)

    @bp.get(f"{LIBRARY_PREFIX}/artists")
    def artists():
        viewer()
        return jsonify({"artists": store.list_artists()})

    @bp.get(f"{LIBRARY_PREFIX}/albums")
    def albums():
        viewer()
        return jsonify({"albums": store.list_albums()})

    @bp.get(f"{LIBRARY_PREFIX}/genres")
    def genres():
        viewer()
        return jsonify({"genres": store.list_genres()})

    # --------------------------------------------------------------------- playlists

    @bp.get(f"{LIBRARY_PREFIX}/playlists")
    def playlists_list():
        me = viewer()
        playlists = store.list_playlists_for_user(me["id"])
        return jsonify({
            "mine": [p for p in playlists if p["owner_id"] == me["id"]],
            "shared": [p for p in playlists if p["owner_id"] != me["id"]],
        })

    @bp.post(f"{LIBRARY_PREFIX}/playlists")
    def playlists_create():
        me = viewer()
        body = body_json()
        name = str(body.get("name") or "").strip()
        if not name:
            raise HttpError(400, "name is required")
        description = str(body.get("description") or "").strip() or None
        song_ids = [int_param(v, "songIds[]") for v in body.get("songIds")] if isinstance(body.get("songIds"), list) else []
        if song_ids:
            exist = store.existing_song_ids(song_ids)
            missing = [s for s in song_ids if s not in exist]
            if missing:
                raise HttpError(400, f"unknown song id(s): {', '.join(str(s) for s in missing)}")
        result = store.create_playlist_with_songs(me["id"], name, description, song_ids)
        logger.log("library: playlist created", {
            "playlistId": result["playlistId"], "user": me["username"], "name": name, "added": result["added"],
        }, "createPlaylist")
        return jsonify(result)

    @bp.get(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>")
    def playlist_detail(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        assert_can_view(playlist, me["id"])

        item_rows = store.playlist_item_rows(playlist_id)
        songs = store.songs_by_ids([it["song_id"] for it in item_rows])
        view_by_id = {v["id"]: v for v in to_song_views(songs)}
        owner = store.get_user(playlist["owner_id"])
        collabs = store.list_collaborators(playlist_id)
        me_collab = next((c for c in collabs if c["user_id"] == me["id"]), None)

        items = []
        for it in item_rows:
            song = view_by_id.get(it["song_id"])
            if not song:
                continue  # song deleted out from under the row
            items.append({
                "id": it["id"], "position": it["position"], "added_by": it["added_by"],
                "added_by_username": it["added_by_username"], "added_at": it["added_at"], "song": song,
            })
        return jsonify({
            "playlist": {
                **playlist,
                "owner_username": owner["username"] if owner else f"user {playlist['owner_id']}",
                "can_edit": playlist["owner_id"] == me["id"] or (me_collab is not None and me_collab["can_edit"]),
                "items": items,
            },
            "collaborators": collabs,
        })

    @bp.patch(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>")
    def playlist_update(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        assert_can_edit(playlist, me["id"])
        body = body_json()
        fields = {}
        if "name" in body:
            name = str(body.get("name") or "").strip()
            if not name:
                raise HttpError(400, "name cannot be empty")
            fields["name"] = name
        if "description" in body:
            fields["description"] = str(body.get("description"))
        if not fields:
            raise HttpError(400, "nothing to update (send name and/or description)")

        store.update_playlist(playlist_id, fields)
        if "name" in fields:
            store.notify_participants(
                playlist_id=playlist_id, actor_id=me["id"], owner_id=playlist["owner_id"],
                type_="playlist_renamed", payload={"name": fields["name"]},
            )
        logger.log("library: playlist updated", {"playlistId": playlist_id, "user": me["username"], "fields": list(fields)})
        return jsonify({"ok": True})

    @bp.delete(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>")
    def playlist_delete(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        # Owner only: a collaborator who could delete would delete the owner's playlist.
        if playlist["owner_id"] != me["id"]:
            raise HttpError(403, "only the owner can delete this playlist")
        store.delete_playlist(playlist_id)
        logger.log("library: playlist deleted", {"playlistId": playlist_id, "user": me["username"]})
        return jsonify({"ok": True, "deletedPlaylist": playlist_id})

    # ---------------------------------------------------------------- playlist items

    @bp.post(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>/items")
    def playlist_items_add(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        assert_can_edit(playlist, me["id"])
        body = body_json()
        song_ids = [int_param(v, "songIds[]") for v in body.get("songIds")] if isinstance(body.get("songIds"), list) else []
        if not song_ids:
            raise HttpError(400, "songIds[] is required and must be non-empty")
        exist = store.existing_song_ids(song_ids)
        missing = [s for s in song_ids if s not in exist]
        if missing:
            raise HttpError(400, f"unknown song id(s): {', '.join(str(s) for s in missing)}")
        added = store.add_playlist_items(playlist_id, song_ids, me["id"])
        notified = store.notify_participants(
            playlist_id=playlist_id, actor_id=me["id"], owner_id=playlist["owner_id"],
            type_="playlist_edited", payload={"action": "add", "count": added, "songIds": song_ids},
        )
        logger.log("library: playlist items added", {"playlistId": playlist_id, "user": me["username"], "added": added, "notifiedUsers": notified})
        return jsonify({"added": added, "notifiedUsers": notified})

    @bp.delete(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>/items/<int:item_id>")
    def playlist_item_remove(playlist_id, item_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        assert_can_edit(playlist, me["id"])
        if not store.remove_playlist_item(item_id, playlist_id):
            raise HttpError(404, "playlist item not found")
        notified = store.notify_participants(
            playlist_id=playlist_id, actor_id=me["id"], owner_id=playlist["owner_id"],
            type_="playlist_edited", payload={"action": "remove", "itemId": item_id},
        )
        logger.log("library: playlist item removed", {"playlistId": playlist_id, "itemId": item_id, "user": me["username"], "notifiedUsers": notified})
        return jsonify({"ok": True, "notifiedUsers": notified})

    # ----------------------------------------------------------------------- sharing

    @bp.post(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>/share")
    def playlist_share(playlist_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        if playlist["owner_id"] != me["id"]:
            raise HttpError(403, "only the owner can share this playlist")
        body = body_json()
        user_id = int_param(body.get("userId"), "userId")
        if user_id == me["id"]:
            raise HttpError(400, "you already own this playlist")
        target = store.get_user(user_id)
        if not target:
            raise HttpError(404, f"no user with id {user_id}")
        can_edit = body.get("canEdit") is True or body.get("canEdit") == "true"
        store.share_playlist(playlist_id, user_id, can_edit, me["id"])
        store.notify(user_id, "playlist_shared", actor_id=me["id"], playlist_id=playlist_id, payload={"canEdit": can_edit})
        logger.log("library: playlist shared", {"playlistId": playlist_id, "owner": me["username"], "with": target["username"], "canEdit": can_edit})
        return jsonify({"playlistId": playlist_id, "sharedWith": {"id": target["id"], "username": target["username"]}, "canEdit": can_edit})

    @bp.delete(f"{LIBRARY_PREFIX}/playlists/<int:playlist_id>/share/<int:user_id>")
    def playlist_unshare(playlist_id, user_id):
        me = viewer()
        playlist = must_get_playlist(playlist_id)
        if playlist["owner_id"] != me["id"]:
            raise HttpError(403, "only the owner can unshare this playlist")
        store.unshare_playlist(playlist_id, user_id)
        store.notify(user_id, "collab_removed", actor_id=me["id"], playlist_id=playlist_id, payload=None)
        logger.log("library: playlist unshared", {"playlistId": playlist_id, "owner": me["username"], "userId": user_id})
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ notifications

    @bp.get(f"{LIBRARY_PREFIX}/notifications")
    def notifications_list():
        me = viewer()
        limit = num_clamp(request.args.get("limit", 50), 50, 1, MAX_PAGE)
        return jsonify({
            "notifications": store.list_notifications(me["id"], int(limit)),
            "unread": store.unread_notification_count(me["id"]),
            "pendingImports": store.pending_import_count(me["id"]),
        })

    @bp.post(f"{LIBRARY_PREFIX}/notifications/read")
    def notifications_read():
        me = viewer()
        body = body_json()
        ids = [int_param(v, "ids[]") for v in body.get("ids")] if isinstance(body.get("ids"), list) and body["ids"] else None
        return jsonify({"marked": store.mark_notifications_read(me["id"], ids)})

    @bp.get(f"{LIBRARY_PREFIX}/me")
    def me():
        me = viewer()
        playlists = store.list_playlists_for_user(me["id"])
        return jsonify({
            "user": me,
            "pendingImports": store.pending_import_count(me["id"]),
            "unreadNotifications": store.unread_notification_count(me["id"]),
            "myPlaylists": sum(1 for p in playlists if p["owner_id"] == me["id"]),
            "sharedWithMe": sum(1 for p in playlists if p["owner_id"] != me["id"]),
            "librarySongs": store.search_songs(limit=1, offset=0)["total"],
        })

    # ------------------------------------------------------------------------- errors

    @bp.errorhandler(HttpError)
    def handle_http_error(err):
        return (err.message, err.status, {"Content-Type": "text/plain; charset=utf-8"})

    app.register_blueprint(bp)
