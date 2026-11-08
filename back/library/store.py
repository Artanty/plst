"""LibraryStore — port of back-node-js/src/library/store.ts (behavior frozen by its tests).

The scan-import transaction keeps all three deadlock fixes: batched multi-row writes, fixed
phase order with every phase sorted by dedup_key, and retry on ER_LOCK_DEADLOCK / lock timeout.
"""
import hashlib
import json
import time

from lib.logger import logger
from .keys import album_key, artist_key, song_dedup_key

SEED_USERS = [
    {"username": "artyom", "displayName": "Artyom"},
    {"username": "zaur", "displayName": "Zaur"},
]

BATCH_ROWS = 200
DEADLOCK_CODES = (1213, 1205)  # ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT


def now() -> float:
    return time.time()


def _chunks(rows, size=BATCH_ROWS):
    return [rows[i : i + size] for i in range(0, len(rows), size)]


def _escape_like(s: str) -> str:
    # Without this, a search for "100%" or "a_b" silently becomes a wildcard scan.
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _safe_parse(s):
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None


def _mysql_errno(err) -> int | None:
    """PyMySQL errors carry the errno as args[0]."""
    args = getattr(err, "args", ())
    return args[0] if args and isinstance(args[0], int) else getattr(err, "errno", None)


class LibraryStore:
    def __init__(self, db):
        self.db = db

    # ------------------------------------------------------------------ users

    def seed_users(self, users=None):
        for u in users or SEED_USERS:
            self.db.execute(
                "INSERT INTO users (username, display_name, created_at) VALUES (%(u)s,%(d)s,%(c)s)"
                " ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)",
                {"u": u["username"], "d": u["displayName"], "c": now()},
            )
        logger.log("library: users seeded", {"usernames": [u["username"] for u in (users or SEED_USERS)]})

    def list_users(self):
        return self.db.fetchall("SELECT id, username, display_name FROM users ORDER BY id")

    def get_user(self, user_id):
        if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
            return None
        return self.db.fetchone("SELECT id, username, display_name FROM users WHERE id = %(id)s", {"id": user_id})

    # ------------------------------------------------------------------- scan

    def import_scan(self, user_id, tracks, source_label=None, page_url=None):
        """Dedup within one scan (map keeps scan order), then the transactional import with
        deadlock retry. Returns {importId, trackCount, newCount, dupCount, skippedCount}."""
        seen: dict[str, dict] = {}
        skipped = 0
        for track in tracks:
            artists = [a.strip() for a in (track.get("artists") or ["Unknown"]) if a.strip()]
            if not artists:
                artists = ["Unknown"]
            dkey = song_dedup_key(track["title"], artists, track.get("durationS") or 0)
            if dkey in seen:
                skipped += 1
                continue
            seen[dkey] = {
                "dkey": dkey,
                "title": track["title"].strip(),
                "artists": artists,
                "album": (track.get("album") or "").strip() or None,
                "durationS": track.get("durationS") or 0,
            }
        prepared = list(seen.values())

        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            try:
                return self._import_scan_once(user_id, source_label, page_url, prepared, skipped)
            except Exception as err:
                mysql_errno = _mysql_errno(err)
                if mysql_errno not in DEADLOCK_CODES:
                    raise
                if attempt == max_attempts:
                    raise
                # warn, not error: the retryable path doing its job.
                logger.warn(
                    "library: scan import hit a lock conflict, retrying",
                    {"attempt": attempt, "maxAttempts": max_attempts, "code": mysql_errno, "tracks": len(prepared)},
                )

    def _import_scan_once(self, user_id, source_label, page_url, prepared, skipped):
        with self.db.transaction() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO imports (user_id, source, source_label, page_url, raw_count, track_count, created_at)"
                " VALUES (%(u)s,'yandex_scan',%(label)s,%(url)s,%(raw)s,0,%(c)s)",
                {"u": user_id, "label": source_label, "url": page_url, "raw": len(prepared) + skipped, "c": now()},
            )
            import_id = cur.lastrowid

            # Phase 1 — artists (sorted by dedup_key; fixed lock order across concurrent imports).
            artist_by_key: dict[str, str] = {}
            for t in prepared:
                for name in t["artists"]:
                    k = artist_key(name)
                    artist_by_key.setdefault(k, name)
            cur.executemany(
                "INSERT INTO artists (name, dedup_key) VALUES (%(name)s,%(key)s) ON DUPLICATE KEY UPDATE name = name",
                [{"name": n, "key": k} for k, n in sorted(artist_by_key.items())],
            )
            artist_id = self._id_map(cur, "artists", list(artist_by_key.keys()))

            # Phase 2 — albums, keyed on (title, owning artist id, year).
            album_by_key: dict[str, dict] = {}
            for t in prepared:
                if not t["album"]:
                    continue
                aid = artist_id.get(artist_key(t["artists"][0])) if t["artists"] else None
                k = album_key(t["album"], aid, None)
                album_by_key.setdefault(k, {"title": t["album"], "artistId": aid})
            cur.executemany(
                "INSERT INTO albums (title, artist_id, year, dedup_key)"
                " VALUES (%(title)s,%(artist_id)s,%(year)s,%(key)s) ON DUPLICATE KEY UPDATE title = title",
                [
                    {"title": a["title"], "artist_id": a["artistId"], "year": None, "key": k}
                    for k, a in sorted(album_by_key.items())
                ],
            )
            album_id = self._id_map(cur, "albums", list(album_by_key.keys()))

            # Phase 3 — songs; `existing` (pre-read inside the transaction) decides is_new.
            existing = self._id_map(cur, "songs", [t["dkey"] for t in prepared])
            seen_at = now()
            cur.executemany(
                """INSERT INTO songs (dedup_key, title, duration_s, album_id, first_seen_at, last_seen_at, seen_count)
                   VALUES (%(key)s,%(title)s,%(dur)s,%(album)s,%(first)s,%(last)s,1)
                   ON DUPLICATE KEY UPDATE
                     last_seen_at = VALUES(last_seen_at),
                     seen_count   = seen_count + 1,
                     play_count   = play_count + 1,
                     album_id     = COALESCE(songs.album_id, VALUES(album_id))""",
                [
                    {
                        "key": t["dkey"],
                        "title": t["title"],
                        "dur": t["durationS"],
                        "album": (
                            album_id.get(album_key(t["album"], artist_id.get(artist_key(t["artists"][0])) if t["artists"] else None, None))
                            if t["album"]
                            else None
                        ),
                        "first": seen_at,
                        "last": seen_at,
                    }
                    for t in sorted(prepared, key=lambda t: t["dkey"])
                ],
            )
            song_id = self._id_map(cur, "songs", [t["dkey"] for t in prepared])

            # Phase 4 — artist_songs, sorted on (song_id, artist_id).
            link_rows = []
            for t in prepared:
                sid = song_id.get(t["dkey"])
                if sid is None:
                    raise RuntimeError(f"song disappeared right after upsert ({t['dkey']})")
                for i, name in enumerate(t["artists"]):
                    aid = artist_id.get(artist_key(name))
                    if aid is None:
                        continue
                    link_rows.append({"song_id": sid, "artist_id": aid, "position": i, "role": "main" if i == 0 else "feat"})
            cur.executemany(
                "INSERT INTO artist_songs (song_id, artist_id, position, role)"
                " VALUES (%(song_id)s,%(artist_id)s,%(position)s,%(role)s)"
                " ON DUPLICATE KEY UPDATE position = VALUES(position), role = VALUES(role)",
                sorted(link_rows, key=lambda r: (r["song_id"], r["artist_id"])),
            )

            # import_items keeps SCAN order (position is the order the user saw).
            self._import_items_scan_order(cur, import_id, prepared, song_id, existing)
            new_count = sum(1 for t in prepared if t["dkey"] not in existing)
            cur.execute(
                "UPDATE imports SET track_count=%(tc)s, new_song_count=%(nc)s, skipped_count=%(sk)s WHERE id=%(id)s",
                {"tc": len(prepared), "nc": new_count, "sk": skipped, "id": import_id},
            )
        logger.log("library: scan imported", {"importId": import_id, "userId": user_id, "tracks": len(prepared), "newCount": new_count, "skipped": skipped})
        return {
            "importId": import_id,
            "trackCount": len(prepared),
            "newCount": new_count,
            "dupCount": len(prepared) - new_count,
            "skippedCount": skipped,
        }

    def _import_items_scan_order(self, cur, import_id, prepared, song_id, existing):
        """Scan order is global (import_items.position = the order the user saw)."""
        for chunk in _chunks(prepared):
            start = prepared.index(chunk[0])
            cur.executemany(
                "INSERT INTO import_items (import_id, song_id, position, is_new) VALUES (%(i)s,%(s)s,%(p)s,%(n)s)",
                [
                    {"i": import_id, "s": song_id[t["dkey"]], "p": start + idx, "n": 0 if t["dkey"] in existing else 1}
                    for idx, t in enumerate(chunk)
                ],
            )

    @staticmethod
    def _id_map(cur, table: str, keys: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        unique_keys = list(dict.fromkeys(keys))
        for chunk in _chunks(unique_keys):
            ph = ", ".join(f"%({i})s" for i in range(len(chunk)))
            params = {f"{i}": k for i, k in enumerate(chunk)}
            cur.execute(f"SELECT id, dedup_key FROM {table} WHERE dedup_key IN ({ph})", params)
            for row in cur.fetchall():
                out[row["dedup_key"]] = row["id"]
        return out

    # ---------------------------------------------------------------- imports

    def pending_imports(self, user_id):
        rows = self.db.fetchall(
            "SELECT i.*, (SELECT COUNT(*) FROM import_items ii WHERE ii.import_id = i.id) AS item_count"
            " FROM imports i WHERE i.user_id = %(u)s AND i.is_processed = 0 ORDER BY i.id DESC",
            {"u": user_id},
        )
        for r in rows:
            r["item_count"] = int(r["item_count"])
        return rows

    def pending_import_count(self, user_id) -> int:
        row = self.db.fetchone(
            "SELECT COUNT(*) AS n FROM imports WHERE user_id = %(u)s AND is_processed = 0", {"u": user_id}
        )
        return int(row["n"]) if row else 0

    def get_import(self, import_id):
        return self.db.fetchone("SELECT * FROM imports WHERE id = %(id)s", {"id": import_id})

    def import_item_song_ids(self, import_id, limit=5000, offset=0):
        rows = self.db.fetchall(
            "SELECT song_id FROM import_items WHERE import_id = %(id)s ORDER BY position, song_id LIMIT %(limit)s OFFSET %(offset)s",
            {"id": import_id, "limit": limit, "offset": offset},
        )
        return [r["song_id"] for r in rows]

    def import_new_song_ids(self, import_id):
        rows = self.db.fetchall(
            "SELECT song_id FROM import_items WHERE import_id = %(id)s AND is_new = 1 ORDER BY position",
            {"id": import_id},
        )
        return [r["song_id"] for r in rows]

    def mark_import_processed(self, import_id, playlist_id):
        self.db.execute(
            "UPDATE imports SET is_processed = 1, playlist_id = %(p)s, processed_at = %(t)s WHERE id = %(id)s",
            {"p": playlist_id, "t": now(), "id": import_id},
        )

    # ------------------------------------------------------------------ songs

    def search_songs(self, q=None, album_id=None, artist_id=None, genre_id=None, limit=50, offset=0):
        where = []
        args = {}
        if q and q.strip():
            like = f"%{_escape_like(q.strip())}%"
            where.append(
                "(s.title LIKE %(like)s ESCAPE '\\\\' OR EXISTS ("
                " SELECT 1 FROM artist_songs x JOIN artists a ON a.id = x.artist_id"
                " WHERE x.song_id = s.id AND a.name LIKE %(like)s ESCAPE '\\\\'))"
            )
            args["like"] = like
        if album_id:
            where.append("s.album_id = %(album_id)s")
            args["album_id"] = album_id
        if artist_id:
            where.append("EXISTS (SELECT 1 FROM artist_songs x WHERE x.song_id = s.id AND x.artist_id = %(artist_id)s)")
            args["artist_id"] = artist_id
        if genre_id:
            where.append("EXISTS (SELECT 1 FROM song_genres x WHERE x.song_id = s.id AND x.genre_id = %(genre_id)s)")
            args["genre_id"] = genre_id

        clause = f"WHERE {' AND '.join(where)}" if where else ""
        count_row = self.db.fetchone(f"SELECT COUNT(*) AS n FROM songs s {clause}", args)
        rows = self.db.fetchall(
            f"SELECT s.* FROM songs s {clause} ORDER BY s.title LIMIT %(limit)s OFFSET %(offset)s",
            {**args, "limit": limit, "offset": offset},
        )
        return {"total": int(count_row["n"]) if count_row else 0, "rows": rows}

    def song_extras(self, songs):
        """One batched pass: three IN-clauses instead of three queries per row."""
        ids = [s["id"] for s in songs]
        out = {s["id"]: {"artists": [], "genres": [], "album_title": None} for s in songs}
        if not ids:
            return out

        ph = ", ".join(f"%({i})s" for i in range(len(ids)))
        params = {f"{i}": v for i, v in enumerate(ids)}
        artists = self.db.fetchall(
            f"""SELECT x.song_id, a.id, a.name, x.role
                FROM artist_songs x JOIN artists a ON a.id = x.artist_id
                WHERE x.song_id IN ({ph}) ORDER BY x.position, a.name""",
            params,
        )
        for a in artists:
            out[a["song_id"]]["artists"].append({"id": a["id"], "name": a["name"], "role": a["role"]})

        genres = self.db.fetchall(
            f"""SELECT sg.song_id, g.id, g.name, sg.weight
                FROM song_genres sg JOIN genres g ON g.id = sg.genre_id
                WHERE sg.song_id IN ({ph}) ORDER BY sg.weight DESC, g.name""",
            params,
        )
        for g in genres:
            out[g["song_id"]]["genres"].append({"id": g["id"], "name": g["name"], "weight": g["weight"]})

        album_ids = list({s["album_id"] for s in songs if s.get("album_id") is not None})
        if album_ids:
            ph2 = ", ".join(f"%({i})s" for i in range(len(album_ids)))
            params2 = {f"{i}": v for i, v in enumerate(album_ids)}
            albums = self.db.fetchall(f"SELECT id, title FROM albums WHERE id IN ({ph2})", params2)
            title_by_id = {a["id"]: a["title"] for a in albums}
            for s in songs:
                if s.get("album_id") is not None:
                    out[s["id"]]["album_title"] = title_by_id.get(s["album_id"])
        return out

    def get_song(self, song_id):
        return self.db.fetchone("SELECT * FROM songs WHERE id = %(id)s", {"id": song_id})

    def songs_by_ids(self, ids):
        """Many songs at once, preserving the caller's id order (a playlist may repeat a song)."""
        if not ids:
            return []
        ph = ", ".join(f"%({i})s" for i in range(len(ids)))
        params = {f"{i}": v for i, v in enumerate(ids)}
        rows = self.db.fetchall(f"SELECT * FROM songs WHERE id IN ({ph})", params)
        by_id = {r["id"]: r for r in rows}
        return [by_id[i] for i in ids if i in by_id]

    def list_artists(self, limit=300):
        return self.db.fetchall(
            """SELECT a.id, a.name FROM artists a
               ORDER BY (SELECT COUNT(*) FROM artist_songs x WHERE x.artist_id = a.id) DESC, a.name
               LIMIT %(limit)s""",
            {"limit": limit},
        )

    def list_albums(self, limit=300):
        rows = self.db.fetchall(
            """SELECT al.id, al.title, al.artist_id, al.year,
                      (SELECT COUNT(*) FROM songs s WHERE s.album_id = al.id) AS song_count
               FROM albums al ORDER BY al.title LIMIT %(limit)s""",
            {"limit": limit},
        )
        for r in rows:
            r["song_count"] = int(r["song_count"])
        return rows

    def list_genres(self):
        rows = self.db.fetchall(
            """SELECT g.id, g.name, (SELECT COUNT(*) FROM song_genres sg WHERE sg.genre_id = g.id) AS song_count
               FROM genres g ORDER BY g.name"""
        )
        for r in rows:
            r["song_count"] = int(r["song_count"])
        return rows

    # -------------------------------------------------------------- playlists

    def create_playlist(self, owner_id, name, description):
        t = now()
        conn = self.db.pool.connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO playlists (owner_id, name, description, created_at, updated_at) VALUES (%(o)s,%(n)s,%(d)s,%(c)s,%(u)s)",
                    {"o": owner_id, "n": name, "d": description, "c": t, "u": t},
                )
                return cur.lastrowid
        finally:
            conn.close()

    def create_playlist_with_songs(self, owner_id, name, description, song_ids):
        """Create + fill in ONE transaction (no empty playlist left behind on a failed fill)."""
        if not song_ids:
            return {"playlistId": self.create_playlist(owner_id, name, description), "added": 0}
        t = now()
        with self.db.transaction() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO playlists (owner_id, name, description, created_at, updated_at) VALUES (%(o)s,%(n)s,%(d)s,%(c)s,%(u)s)",
                    {"o": owner_id, "n": name, "d": description, "c": t, "u": t},
                )
                playlist_id = cur.lastrowid
                cur.executemany(
                    "INSERT INTO playlist_items (playlist_id, song_id, position, added_by, added_at)"
                    " VALUES (%(p)s,%(s)s,%(pos)s,%(by)s,%(at)s)",
                    [
                        {"p": playlist_id, "s": song_id, "pos": i, "by": owner_id, "at": t}
                        for i, song_id in enumerate(song_ids)
                    ],
                )
        return {"playlistId": playlist_id, "added": len(song_ids)}

    def get_playlist(self, playlist_id):
        return self.db.fetchone("SELECT * FROM playlists WHERE id = %(id)s", {"id": playlist_id})

    def update_playlist(self, playlist_id, fields):
        sets = []
        args = {}
        if "name" in fields:
            sets.append("name = %(name)s")
            args["name"] = fields["name"]
        if "description" in fields:
            sets.append("description = %(description)s")
            args["description"] = fields["description"]
        if not sets:
            return
        sets.append("updated_at = %(u)s")
        args["u"] = now()
        args["id"] = playlist_id
        self.db.execute(f"UPDATE playlists SET {', '.join(sets)} WHERE id = %(id)s", args)

    def delete_playlist(self, playlist_id):
        """Cascades to items/collaborators/notifications. Songs deliberately NOT touched."""
        self.db.execute("DELETE FROM playlists WHERE id = %(id)s", {"id": playlist_id})

    def list_playlists_for_user(self, user_id):
        rows = self.db.fetchall(
            """SELECT p.*, u.username AS owner_username,
                      (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
                      (p.owner_id = %(u)s) AS is_owner,
                      (SELECT pc.can_edit FROM playlist_collaborators pc
                       WHERE pc.playlist_id = p.id AND pc.user_id = %(u)s) AS collab_can_edit,
                      EXISTS(SELECT 1 FROM playlist_collaborators pc2
                             WHERE pc2.playlist_id = p.id AND pc2.user_id = %(u)s) AS shared_with_me
               FROM playlists p JOIN users u ON u.id = p.owner_id
               WHERE p.owner_id = %(u)s OR EXISTS(SELECT 1 FROM playlist_collaborators pc3
                                                  WHERE pc3.playlist_id = p.id AND pc3.user_id = %(u)s)
               ORDER BY p.updated_at DESC, p.id DESC""",
            {"u": user_id},
        )
        return [
            {
                "id": r["id"],
                "owner_id": r["owner_id"],
                "name": r["name"],
                "description": r["description"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "owner_username": r["owner_username"],
                "item_count": int(r["item_count"]),
                "can_edit": bool(r["is_owner"]) or bool(r["collab_can_edit"]),
                "shared_with_me": bool(r["shared_with_me"]),
            }
            for r in rows
        ]

    def list_collaborators(self, playlist_id):
        rows = self.db.fetchall(
            """SELECT pc.user_id, u.username, u.display_name, pc.can_edit, pc.shared_at
               FROM playlist_collaborators pc JOIN users u ON u.id = pc.user_id
               WHERE pc.playlist_id = %(id)s ORDER BY pc.shared_at""",
            {"id": playlist_id},
        )
        for r in rows:
            r["can_edit"] = bool(r["can_edit"])
        return rows

    def share_playlist(self, playlist_id, user_id, can_edit, shared_by):
        self.db.execute(
            """INSERT INTO playlist_collaborators (playlist_id, user_id, can_edit, shared_by, shared_at)
               VALUES (%(p)s,%(u)s,%(e)s,%(by)s,%(at)s)
               ON DUPLICATE KEY UPDATE can_edit = VALUES(can_edit), shared_by = VALUES(shared_by),
                                       shared_at = VALUES(shared_at)""",
            {"p": playlist_id, "u": user_id, "e": 1 if can_edit else 0, "by": shared_by, "at": now()},
        )

    def unshare_playlist(self, playlist_id, user_id):
        self.db.execute(
            "DELETE FROM playlist_collaborators WHERE playlist_id = %(p)s AND user_id = %(u)s",
            {"p": playlist_id, "u": user_id},
        )

    def collaborator_ids(self, playlist_id):
        return [r["user_id"] for r in self.db.fetchall(
            "SELECT user_id FROM playlist_collaborators WHERE playlist_id = %(id)s", {"id": playlist_id}
        )]

    # --------------------------------------------------------- playlist items

    def add_playlist_items(self, playlist_id, song_ids, added_by):
        if not song_ids:
            return 0
        row = self.db.fetchone(
            "SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = %(id)s",
            {"id": playlist_id},
        )
        pos = int(row["m"] if row else -1) + 1
        t = now()
        conn = self.db.pool.connection()
        try:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO playlist_items (playlist_id, song_id, position, added_by, added_at)"
                    " VALUES (%(p)s,%(s)s,%(pos)s,%(by)s,%(at)s)",
                    [
                        {"p": playlist_id, "s": song_id, "pos": position, "by": added_by, "at": t}
                        for position, song_id in enumerate(song_ids, start=pos)
                    ],
                )
                added = cur.rowcount
        finally:
            conn.close()
        self.db.execute("UPDATE playlists SET updated_at = %(t)s WHERE id = %(id)s", {"t": t, "id": playlist_id})
        return added

    def remove_playlist_item(self, item_id, playlist_id) -> bool:
        removed = self.db.execute(
            "DELETE FROM playlist_items WHERE id = %(i)s AND playlist_id = %(p)s",
            {"i": item_id, "p": playlist_id},
        )
        self.db.execute("UPDATE playlists SET updated_at = %(t)s WHERE id = %(id)s", {"t": now(), "id": playlist_id})
        return removed > 0

    def playlist_item_rows(self, playlist_id):
        return self.db.fetchall(
            """SELECT pi.id, pi.song_id, pi.position, pi.added_by, pi.added_at, u.username AS added_by_username
               FROM playlist_items pi JOIN users u ON u.id = pi.added_by
               WHERE pi.playlist_id = %(id)s ORDER BY pi.position, pi.id""",
            {"id": playlist_id},
        )

    def existing_song_ids(self, ids) -> set:
        if not ids:
            return set()
        ph = ", ".join(f"%({i})s" for i in range(len(ids)))
        params = {f"{i}": v for i, v in enumerate(ids)}
        return {r["id"] for r in self.db.fetchall(f"SELECT id FROM songs WHERE id IN ({ph})", params)}

    # ------------------------------------------------------ youtube matching

    def matchable_songs(self, ids):
        """Song rows shaped for the matcher, artists resolved (a list — comma-strings can't resplit)."""
        songs = self.songs_by_ids(ids)
        if not songs:
            return []
        extras = self.song_extras(songs)
        return [
            {
                "id": s["id"],
                "title": s["title"],
                "artists": [a["name"] for a in extras.get(s["id"], {}).get("artists", [])],
                "album": extras.get(s["id"], {}).get("album_title"),
                "duration": s["duration_s"],
                "yt_video_id": s["yt_video_id"],
                "match_score": s["match_score"],
                "match_status": s["match_status"],
            }
            for s in songs
        ]

    def set_song_match(self, song_id, video_id, score, status):
        """A null videoId stores 'tried, found nothing' so a re-match stays possible; match_status
        carries the VERDICT ('search_failed' = retry-worthy, vs 'not_found' = a real answer)."""
        self.db.execute(
            "UPDATE songs SET yt_video_id = %(v)s, match_score = %(s)s, match_status = %(st)s, matched_at = %(t)s WHERE id = %(id)s",
            {"v": video_id, "s": score, "st": status, "t": now(), "id": song_id},
        )

    def playlist_songs_for_links(self, playlist_id):
        rows = self.db.fetchall(
            "SELECT song_id FROM playlist_items WHERE playlist_id = %(id)s ORDER BY position, id",
            {"id": playlist_id},
        )
        return self.matchable_songs([r["song_id"] for r in rows])

    def song_ids_for_export(self, ids):
        return [s["id"] for s in self.songs_by_ids(ids)]

    # --------------------------------------------------------- notifications

    def notify(self, user_id, type_, actor_id=None, playlist_id=None, import_id=None, payload=None):
        self.db.execute(
            "INSERT INTO notifications (user_id, type, actor_id, playlist_id, import_id, payload_json, created_at)"
            " VALUES (%(u)s,%(t)s,%(a)s,%(p)s,%(i)s,%(pj)s,%(c)s)",
            {
                "u": user_id, "t": type_, "a": actor_id, "p": playlist_id, "i": import_id,
                "pj": json.dumps(payload) if payload is not None else None, "c": now(),
            },
        )

    def notify_participants(self, playlist_id, actor_id, owner_id, type_, payload=None) -> int:
        """Notify every participant EXCEPT the actor — the single place the exclusion lives."""
        ids = set(self.collaborator_ids(playlist_id))
        ids.add(owner_id)
        ids.discard(actor_id)
        for user_id in ids:
            self.notify(user_id, type_, actor_id=actor_id, playlist_id=playlist_id, payload=payload)
        return len(ids)

    def list_notifications(self, user_id, limit=50):
        rows = self.db.fetchall(
            """SELECT n.id, n.user_id, n.type, n.actor_id, n.playlist_id, n.import_id, n.payload_json,
                      n.is_read, n.created_at, a.username AS actor_username, p.name AS playlist_name
               FROM notifications n
               LEFT JOIN users a ON a.id = n.actor_id
               LEFT JOIN playlists p ON p.id = n.playlist_id
               WHERE n.user_id = %(u)s ORDER BY n.id DESC LIMIT %(limit)s""",
            {"u": user_id, "limit": limit},
        )
        return [
            {
                "id": r["id"], "user_id": r["user_id"], "type": r["type"], "actor_id": r["actor_id"],
                "playlist_id": r["playlist_id"], "import_id": r["import_id"], "created_at": r["created_at"],
                "actor_username": r["actor_username"], "playlist_name": r["playlist_name"],
                "is_read": bool(r["is_read"]), "payload": _safe_parse(r["payload_json"]) if r["payload_json"] else None,
            }
            for r in rows
        ]

    def unread_notification_count(self, user_id) -> int:
        row = self.db.fetchone(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id = %(u)s AND is_read = 0", {"u": user_id}
        )
        return int(row["n"]) if row else 0

    def mark_notifications_read(self, user_id, ids) -> int:
        if ids:
            ph = ", ".join(f"%({i})s" for i in range(len(ids)))
            params = {f"{i}": v for i, v in enumerate(ids)}
            return self.db.execute(
                f"UPDATE notifications SET is_read = 1 WHERE user_id = %(u)s AND id IN ({ph})",
                {**params, "u": user_id},
            )
        return self.db.execute(
            "UPDATE notifications SET is_read = 1 WHERE user_id = %(u)s AND is_read = 0", {"u": user_id}
        )
