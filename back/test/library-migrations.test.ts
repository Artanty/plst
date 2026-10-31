// songs.match_status exists to tell 'search_failed' (YouTube never reached — retry after fixing
// the network) from 'not_found' (a real answer). The column ships in the CREATE TABLE, but every
// database that already existed predates it, and CREATE TABLE IF NOT EXISTS never adds a column to
// a live table — so the ALTER migration is the only path those installs get, and it is what this
// file exercises: an old-shaped table, the migration, and a re-run.
import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { cleanupLibraryDatabases, makeLibrary } from './mysql.js';
import { migrateLibrarySongs } from '../src/library/migrations.js';

afterAll(async () => {
  await cleanupLibraryDatabases();
});

const poolOf = (store: unknown): Pool => (store as unknown as { pool: Pool }).pool;

const hasMatchStatus = async (pool: Pool): Promise<boolean> => {
  const [cols] = (await pool.query(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'songs' AND COLUMN_NAME = 'match_status'",
  )) as unknown as [{ n: number }[], unknown];
  return cols[0].n > 0;
};

describe('songs.match_status migration', () => {
  it('adds the column to a table that predates it, and is a no-op on re-run', async () => {
    const store = await makeLibrary();
    const pool = poolOf(store);

    // Fresh test databases already have the column (the CREATE TABLE includes it), so stand in for
    // an old install by dropping it — exactly the shape a pre-2026-10-19 database is in.
    await pool.query('ALTER TABLE songs DROP COLUMN match_status');
    expect(await hasMatchStatus(pool)).toBe(false);

    await migrateLibrarySongs(pool);
    expect(await hasMatchStatus(pool)).toBe(true);

    // Idempotent: boot runs this every time, and a second ALTER would throw ER_DUP_FIELDNAME and
    // take the whole server down.
    await migrateLibrarySongs(pool);
    expect(await hasMatchStatus(pool)).toBe(true);

    // The column really carries the verdict the routes now store. The song row is inserted
    // directly — the import path that normally creates songs needs an import + playlist first,
    // and none of that is what this migration is about.
    // insertId comes back in the result header — reading LAST_INSERT_ID() through a separate
    // pool.query could land on a different connection and return another insert's id. The header
    // is the FIRST element of the [rows, fields] tuple mysql2 returns.
    const [inserted] = (await pool.query(
      "INSERT INTO songs (dedup_key, title, duration_s, album_id, first_seen_at, last_seen_at, seen_count) VALUES ('migtest', 'Migration Test', 100, NULL, 0, 0, 1)",
    )) as unknown as [{ insertId: number }, unknown];
    const songId = inserted.insertId;
    await store.setSongMatch(songId, null, 0, 'search_failed');
    const [rows] = (await pool.query('SELECT match_status FROM songs WHERE id=?', [songId])) as unknown as [
      { match_status: string | null }[],
      unknown,
    ];
    expect(rows[0].match_status).toBe('search_failed');
  });
});
