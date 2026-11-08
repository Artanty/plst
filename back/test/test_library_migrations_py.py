"""Port of back-node-js/test/library-migrations.test.ts + library-users.test.ts (user rename).

The user-rename tests mutate the shared users table — every one restores it, so the library
suite (which runs after, alphabetically) sees the seeded users exactly as conftest left them.
"""

import pytest

from library.migrations import migrate_library_songs, migrate_library_users


@pytest.fixture()
def users_restored(db):
    """Restore the seeded users table after tests that rename/insert rows in it."""
    yield
    db.execute("DELETE FROM users WHERE display_name='Someone Else'")
    db.execute("UPDATE users SET username='zaur', display_name='Zaur' WHERE username='friend'")


def test_rename_friend_to_zaur_in_place(db, library, users_restored):
    # Stand in for an install that was seeded before the rename.
    db.execute("UPDATE users SET username='friend', display_name='Friend' WHERE username='zaur'")
    old_id = db.fetchone("SELECT id FROM users WHERE username='friend'")["id"]

    migrate_library_users(db)

    users = library.list_users()
    zaur = next((u for u in users if u["username"] == "zaur"), None)
    assert zaur is not None
    assert zaur["display_name"] == "Zaur"
    # Same row, not a new one — this is the whole point of the migration.
    assert zaur["id"] == old_id
    assert not any(u["username"] == "friend" for u in users)


def test_rename_migration_is_idempotent(db, library):
    migrate_library_users(db)
    migrate_library_users(db)
    users = library.list_users()
    assert sorted(u["username"] for u in users) == ["artyom", "zaur"]


def test_rename_refuses_to_collide_with_a_taken_name(db, library, users_restored):
    db.execute("UPDATE users SET username='friend' WHERE username='zaur'")
    db.execute("INSERT INTO users (username, display_name, created_at) VALUES ('zaur', 'Someone Else', 0)")

    migrate_library_users(db)

    # The migration must leave both rows alone rather than violate uq_users_username.
    names = [r["username"] for r in db.fetchall("SELECT username FROM users ORDER BY id")]
    assert "friend" in names
    assert len([n for n in names if n == "zaur"]) == 1


def _has_match_status(db):
    row = db.fetchone(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS"
        " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'songs' AND COLUMN_NAME = 'match_status'"
    )
    return row["n"] > 0


def test_match_status_migration_adds_column_and_is_noop_on_rerun(db, library):
    # Fresh test databases already have the column (the CREATE TABLE includes it), so stand in for
    # an old install by dropping it — exactly the shape a pre-2026-10-19 database is in.
    db.execute("ALTER TABLE songs DROP COLUMN match_status")
    assert not _has_match_status(db)

    migrate_library_songs(db)
    assert _has_match_status(db)

    # Idempotent: boot runs this every time, and a second ALTER would throw ER_DUP_FIELDNAME and
    # take the whole server down.
    migrate_library_songs(db)
    assert _has_match_status(db)

    # The column really carries the verdict the routes now store. The song row is inserted
    # directly — the import path that normally creates songs needs an import + playlist first,
    # and none of that is what this migration is about.
    with db.transaction() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO songs (dedup_key, title, duration_s, album_id, first_seen_at, last_seen_at, seen_count)"
                " VALUES ('migtest', 'Migration Test', 100, NULL, 0, 0, 1)"
            )
            song_id = cur.lastrowid
    library.set_song_match(song_id, None, 0, "search_failed")
    row = db.fetchone("SELECT match_status FROM songs WHERE id=%(id)s", {"id": song_id})
    assert row["match_status"] == "search_failed"
