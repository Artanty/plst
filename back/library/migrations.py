"""One-off data fixes a CREATE TABLE IF NOT EXISTS cannot express — port of migrations.ts."""
from lib.logger import logger

USER_RENAMES = [
    {"from": "friend", "to": "zaur", "displayName": "Zaur"},
]


def migrate_library_users(db) -> None:
    """Rename seeded users in place (keeps ids → playlists/shares stay attached). Idempotent."""
    for rename in USER_RENAMES:
        old = db.fetchone("SELECT id FROM users WHERE username=%(f)s LIMIT 1", {"f": rename["from"]})
        if not old:
            continue  # fresh install, or the rename already ran
        taken = db.fetchone("SELECT id FROM users WHERE username=%(t)s LIMIT 1", {"t": rename["to"]})
        if taken:
            logger.log(
                "library: user rename skipped — target name already taken",
                {"from": rename["from"], "to": rename["to"], "heldBy": taken["id"]},
            )
            continue
        db.execute(
            "UPDATE users SET username=%(t)s, display_name=%(d)s WHERE username=%(f)s",
            {"t": rename["to"], "d": rename["displayName"], "f": rename["from"]},
        )
        logger.log("library: user renamed in place", {"from": rename["from"], "to": rename["to"], "id": old["id"]})


def migrate_library_songs(db) -> None:
    """songs.match_status records the VERDICT ('search_failed' vs 'not_found' etc.) which
    yt_video_id=null alone cannot express. ALTER (not a schema edit): CREATE TABLE IF NOT EXISTS
    never alters an existing DB. information_schema check makes a re-run a no-op."""
    row = db.fetchone(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS"
        " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'songs' AND COLUMN_NAME = 'match_status'"
    )
    if row and row["n"] > 0:
        return
    db.execute("ALTER TABLE songs ADD COLUMN match_status VARCHAR(16) NULL AFTER match_score")
    logger.log("library: migration added songs.match_status", {})
