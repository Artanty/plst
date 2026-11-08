import type { Pool } from 'mysql2/promise';
import { logger } from '../lib/logger.js';

/**
 * One-off data fixes that a CREATE TABLE IF NOT EXISTS schema cannot express.
 *
 * The second user was seeded as `friend` and is now `zaur`. Editing SEED_USERS alone would NOT
 * rename it: seedUsers upserts on `username`, so a new `zaur` row would be inserted and the old
 * `friend` row would survive — leaving three users, with every playlist `friend` owns still
 * attributed to a name nobody recognises. Renaming the row in place keeps the id, so playlists,
 * playlist_items, shares and notifications all stay attached to the same person.
 *
 * Runs before seedUsers, and is idempotent: a renamed row no longer matches the old username.
 */
const USER_RENAMES: { from: string; to: string; displayName: string }[] = [
  { from: 'friend', to: 'zaur', displayName: 'Zaur' },
];

export async function migrateLibraryUsers(pool: Pool): Promise<void> {
  for (const { from, to, displayName } of USER_RENAMES) {
    const [oldRows] = (await pool.query('SELECT id FROM users WHERE username=? LIMIT 1', [from])) as unknown as [
      { id: number }[],
      unknown,
    ];
    // Nothing to rename — the common case on a fresh install, and after a rename has already run.
    // Checked before the collision case so a clean boot does not log a scary "already taken".
    if (!oldRows.length) continue;

    // Refuse to rename into an occupied name. Two rows sharing a username would violate
    // uq_users_username and take the whole boot down, and "skip loudly" beats that.
    const [taken] = (await pool.query('SELECT id FROM users WHERE username=? LIMIT 1', [to])) as unknown as [
      { id: number }[],
      unknown,
    ];
    if (taken.length) {
      logger.log('library: user rename skipped — target name already taken', { from, to, heldBy: taken[0].id });
      continue;
    }

    const [res] = (await pool.query('UPDATE users SET username=?, display_name=? WHERE username=?', [
      to,
      displayName,
      from,
    ])) as unknown as [{ affectedRows: number }, unknown];

    logger.log('library: user renamed in place', { from, to, id: oldRows[0].id, rows: res.affectedRows });
  }
}

/**
 * songs.match_status ('matched' | 'uncertain' | 'not_found' | 'search_failed') records the VERDICT,
 * which yt_video_id alone cannot: a search that never reached YouTube (dead proxy, blocked network)
 * stored videoId=null exactly like a genuine "not in the catalog". Without this column the export
 * could not tell "never asked" from "asked and absent" and reported a dead proxy as missing songs.
 *
 * ALTER, not a schema edit: LIBRARY_SCHEMA_STATEMENTS is CREATE TABLE IF NOT EXISTS, so an existing
 * database never gains the column from editing the CREATE. Checked via information_schema so a
 * re-run is a no-op (this box runs Percona, which — like MySQL — has no ADD COLUMN IF NOT EXISTS).
 */
export async function migrateLibrarySongs(pool: Pool): Promise<void> {
  const [cols] = (await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'songs' AND COLUMN_NAME = 'match_status'",
  )) as unknown as [{ n: number }[], unknown];
  if (cols[0].n > 0) return;

  await pool.query('ALTER TABLE songs ADD COLUMN match_status VARCHAR(16) NULL AFTER match_score');
  logger.log('library: migration added songs.match_status', {});
}
