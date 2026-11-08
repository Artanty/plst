import { logger } from '../lib/logger.js';

/**
 * Music-library schema. Separate from db.ts's SCHEMA_STATEMENTS only because it is a different
 * concern (the plst job tables vs. the library), not because it is a different database — it goes
 * through the SAME pool and the SAME auto-create-on-boot path.
 *
 * Ids are plain AUTO_INCREMENT, matching db.ts. NOT `GENERATED ALWAYS AS IDENTITY` even though that
 * reads better and is valid on MySQL 8+: the local dev server is Percona Server (it reports 26.7.0
 * with immediate_server_version=999999, i.e. it impersonates MySQL 9.x) and it REJECTS the IDENTITY
 * keyword outright — verified, not guessed. AUTO_INCREMENT runs on both this box and the real
 * MySQL the .env points at, and the upsert path never trusts an insertId anyway (it re-SELECTs).
 *
 * ORDER MATTERS here. songs has an FK to albums and albums has an FK to artists, so artists and
 * albums must be created before songs. MySQL resolves foreign keys per statement, not per file, so
 * a table referenced only by a LATER table (imports -> playlists) is legal as long as the referencing
 * column is added after; that is why the one cross-reference gets its own ALTER at the end.
 */

const IDENTITY = 'BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY';
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const LIBRARY_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id ${IDENTITY},
    username VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    created_at DOUBLE NOT NULL DEFAULT 0,
    UNIQUE KEY uq_users_username (username)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS artists (
    id ${IDENTITY},
    name VARCHAR(512) NOT NULL,
    dedup_key CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY uq_artists_dedup (dedup_key),
    INDEX idx_artists_name (name(191))
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS albums (
    id ${IDENTITY},
    title VARCHAR(512) NOT NULL,
    artist_id BIGINT UNSIGNED NULL,
    year INT NULL,
    dedup_key CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY uq_albums_dedup (dedup_key),
    INDEX idx_albums_title (title(191)),
    CONSTRAINT fk_albums_artist FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  // No user_id here, on purpose. A song is a global fact; USING one is a playlist_items row. That is
  // the entire "one song imported by many users" answer — it needs no link table, so a second
  // scanner bumps last_seen_at instead of inserting a duplicate.
  `CREATE TABLE IF NOT EXISTS songs (
    id ${IDENTITY},
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
  ) ${TABLE_OPTS}`,

  // The feat./multi-artist answer. Artists are never a comma-joined string on a song row: "A, B"
  // cannot be re-split reliably (a band named "Earth, Wind & Fire" would be shredded).
  `CREATE TABLE IF NOT EXISTS artist_songs (
    song_id BIGINT UNSIGNED NOT NULL,
    artist_id BIGINT UNSIGNED NOT NULL,
    position INT NOT NULL DEFAULT 0,
    role VARCHAR(16) NOT NULL DEFAULT 'main',
    PRIMARY KEY (song_id, artist_id),
    INDEX idx_artist_songs_artist (artist_id),
    CONSTRAINT fk_as_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    CONSTRAINT fk_as_artist FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  // Built now, filled by a genre provider later (see genre.ts). Search and the genre filter work
  // from day one against an empty table — no external API key is needed to start.
  `CREATE TABLE IF NOT EXISTS genres (
    id ${IDENTITY},
    name VARCHAR(191) NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_genres_name (name),
    CONSTRAINT fk_genres_parent FOREIGN KEY (parent_id) REFERENCES genres(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS song_genres (
    song_id BIGINT UNSIGNED NOT NULL,
    genre_id BIGINT UNSIGNED NOT NULL,
    weight DOUBLE NOT NULL DEFAULT 0,
    source VARCHAR(32) NOT NULL DEFAULT 'provider',
    PRIMARY KEY (song_id, genre_id),
    INDEX idx_song_genres_genre (genre_id),
    CONSTRAINT fk_sg_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    CONSTRAINT fk_sg_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS playlists (
    id ${IDENTITY},
    owner_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(512) NOT NULL,
    description TEXT NULL,
    created_at DOUBLE NOT NULL DEFAULT 0,
    updated_at DOUBLE NOT NULL DEFAULT 0,
    INDEX idx_playlists_owner (owner_id),
    CONSTRAINT fk_playlists_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS imports (
    id ${IDENTITY},
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
  ) ${TABLE_OPTS}`,

  // The queue payload: which songs this import contributed, in scan order.
  `CREATE TABLE IF NOT EXISTS import_items (
    import_id BIGINT UNSIGNED NOT NULL,
    song_id BIGINT UNSIGNED NOT NULL,
    position INT NOT NULL DEFAULT 0,
    is_new TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (import_id, song_id),
    INDEX idx_import_items_song (song_id),
    CONSTRAINT fk_ii_import FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
    CONSTRAINT fk_ii_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  // A song may legitimately appear twice in a playlist, so this carries its own id instead of being
  // keyed (playlist_id, song_id). added_by is NOT NULL because someone always did the adding.
  `CREATE TABLE IF NOT EXISTS playlist_items (
    id ${IDENTITY},
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
  ) ${TABLE_OPTS}`,

  // "Shared with me". can_edit is the second half of your third requirement.
  `CREATE TABLE IF NOT EXISTS playlist_collaborators (
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
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id ${IDENTITY},
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
  ) ${TABLE_OPTS}`,
];

export interface SchemaRunner {
  query(sql: string): Promise<unknown>;
}

export async function initLibrary(conn: SchemaRunner): Promise<void> {
  for (const stmt of LIBRARY_SCHEMA_STATEMENTS) {
    try {
      await conn.query(stmt);
    } catch (err) {
      if (!isDuplicateConstraint(err)) throw err;
      logger.log('library schema: constraint already present', { stmt: stmt.slice(0, 60) });
    }
  }
}

function isDuplicateConstraint(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key name|duplicate foreign key constraint name|already exists|errno 1061|errno 1826/i.test(msg);
}
