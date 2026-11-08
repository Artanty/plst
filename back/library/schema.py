"""Music-library schema — port of back-node-js/src/library/schema.ts (DDL byte-parity).

Same tables, same FK order rules: artists/albums before songs; the one cross-reference
(imports -> playlists) gets its own ALTER at the end. Ids are AUTO_INCREMENT, never
GENERATED ALWAYS AS IDENTITY (the local Percona rejects IDENTITY outright).
"""
import re

from lib.logger import logger

IDENTITY = "BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY"
TABLE_OPTS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"

LIBRARY_SCHEMA_STATEMENTS = [
    f"""CREATE TABLE IF NOT EXISTS users (
    id {IDENTITY},
    username VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    created_at DOUBLE NOT NULL DEFAULT 0,
    UNIQUE KEY uq_users_username (username)
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS artists (
    id {IDENTITY},
    name VARCHAR(512) NOT NULL,
    dedup_key CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY uq_artists_dedup (dedup_key),
    INDEX idx_artists_name (name(191))
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS albums (
    id {IDENTITY},
    title VARCHAR(512) NOT NULL,
    artist_id BIGINT UNSIGNED NULL,
    year INT NULL,
    dedup_key CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY uq_albums_dedup (dedup_key),
    INDEX idx_albums_title (title(191)),
    CONSTRAINT fk_albums_artist FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL
  ) {TABLE_OPTS}""",
    # No user_id on songs, on purpose: a song is a global fact; USING one is a playlist_items row.
    f"""CREATE TABLE IF NOT EXISTS songs (
    id {IDENTITY},
    dedup_key CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(512) NOT NULL,
    duration_s INT NOT NULL DEFAULT 0,
    album_id BIGINT UNSIGNED NULL,
    yt_video_id VARCHAR(64) NULL,
    match_score DOUBLE NULL,
    match_status VARCHAR(16) NULL,
    matched_at DOUBLE NULL,
    first_seen_at DOUBLE NOT NULL DEFAULT 0,
    last_seen_at DOUBLE NOT NULL DEFAULT 0,
    seen_count INT NOT NULL DEFAULT 0,
    play_count INT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_songs_dedup (dedup_key),
    INDEX idx_songs_title (title(191)),
    INDEX idx_songs_album (album_id),
    INDEX idx_songs_last_seen (last_seen_at),
    CONSTRAINT fk_songs_album FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL
  ) {TABLE_OPTS}""",
    # The feat./multi-artist answer: artists are never a comma-joined string on a song row.
    f"""CREATE TABLE IF NOT EXISTS artist_songs (
    song_id BIGINT UNSIGNED NOT NULL,
    artist_id BIGINT UNSIGNED NOT NULL,
    position INT NOT NULL DEFAULT 0,
    role VARCHAR(16) NOT NULL DEFAULT 'main',
    PRIMARY KEY (song_id, artist_id),
    INDEX idx_artist_songs_artist (artist_id),
    CONSTRAINT fk_as_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    CONSTRAINT fk_as_artist FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    # Built now, filled by a genre provider later; search/filter work from day one on an empty table.
    f"""CREATE TABLE IF NOT EXISTS genres (
    id {IDENTITY},
    name VARCHAR(191) NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_genres_name (name),
    CONSTRAINT fk_genres_parent FOREIGN KEY (parent_id) REFERENCES genres(id) ON DELETE SET NULL
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS song_genres (
    song_id BIGINT UNSIGNED NOT NULL,
    genre_id BIGINT UNSIGNED NOT NULL,
    weight DOUBLE NOT NULL DEFAULT 0,
    source VARCHAR(32) NOT NULL DEFAULT 'provider',
    PRIMARY KEY (song_id, genre_id),
    INDEX idx_song_genres_genre (genre_id),
    CONSTRAINT fk_sg_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    CONSTRAINT fk_sg_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS playlists (
    id {IDENTITY},
    owner_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(512) NOT NULL,
    description TEXT NULL,
    created_at DOUBLE NOT NULL DEFAULT 0,
    updated_at DOUBLE NOT NULL DEFAULT 0,
    INDEX idx_playlists_owner (owner_id),
    CONSTRAINT fk_playlists_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS imports (
    id {IDENTITY},
    user_id BIGINT UNSIGNED NOT NULL,
    source VARCHAR(64) NOT NULL DEFAULT 'yandex_scan',
    source_label VARCHAR(512) NULL,
    page_url VARCHAR(1024) NULL,
    track_count INT NOT NULL DEFAULT 0,
    new_song_count INT NOT NULL DEFAULT 0,
    raw_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    is_processed TINYINT(1) NOT NULL DEFAULT 0,
    playlist_id BIGINT UNSIGNED NULL,
    created_at DOUBLE NOT NULL DEFAULT 0,
    processed_at DOUBLE NULL,
    INDEX idx_imports_user (user_id, is_processed),
    CONSTRAINT fk_imports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_imports_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS import_items (
    import_id BIGINT UNSIGNED NOT NULL,
    song_id BIGINT UNSIGNED NOT NULL,
    position INT NOT NULL DEFAULT 0,
    is_new TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (import_id, song_id),
    INDEX idx_import_items_song (song_id),
    CONSTRAINT fk_ii_import FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
    CONSTRAINT fk_ii_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    # A song may appear twice in a playlist, so this carries its own id.
    f"""CREATE TABLE IF NOT EXISTS playlist_items (
    id {IDENTITY},
    playlist_id BIGINT UNSIGNED NOT NULL,
    song_id BIGINT UNSIGNED NOT NULL,
    position INT NOT NULL DEFAULT 0,
    added_by BIGINT UNSIGNED NOT NULL,
    added_at DOUBLE NOT NULL DEFAULT 0,
    INDEX idx_pi_playlist (playlist_id, position),
    INDEX idx_pi_song (song_id),
    CONSTRAINT fk_pi_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT fk_pi_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    CONSTRAINT fk_pi_user FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS playlist_collaborators (
    playlist_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    can_edit TINYINT(1) NOT NULL DEFAULT 0,
    shared_by BIGINT UNSIGNED NOT NULL,
    shared_at DOUBLE NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, user_id),
    INDEX idx_pc_user (user_id),
    CONSTRAINT fk_pc_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT fk_pc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_pc_shared_by FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
    f"""CREATE TABLE IF NOT EXISTS notifications (
    id {IDENTITY},
    user_id BIGINT UNSIGNED NOT NULL,
    type VARCHAR(32) NOT NULL,
    actor_id BIGINT UNSIGNED NULL,
    playlist_id BIGINT UNSIGNED NULL,
    import_id BIGINT UNSIGNED NULL,
    payload_json TEXT NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at DOUBLE NOT NULL DEFAULT 0,
    INDEX idx_notifications_user (user_id, is_read, id),
    CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_notif_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_notif_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT fk_notif_import FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE
  ) {TABLE_OPTS}""",
]

_DUPLICATE_RE = re.compile(
    r"duplicate key name|duplicate foreign key constraint name|already exists|errno 1061|errno 1826", re.IGNORECASE
)


def init_library(db) -> None:
    """Create every table; a duplicate constraint (re-run against an existing schema) is a no-op."""
    for stmt in LIBRARY_SCHEMA_STATEMENTS:
        try:
            db.execute(stmt)
        except Exception as err:
            if not _DUPLICATE_RE.search(str(err)):
                raise
            logger.log("library schema: constraint already present", {"stmt": stmt[:60]})
