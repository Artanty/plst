import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { cleanupLibraryDatabases, makeLibrary } from './mysql.js';
import { migrateLibraryUsers } from '../src/library/migrations.js';

afterAll(async () => {
  await cleanupLibraryDatabases();
});

const poolOf = (store: unknown): Pool => (store as unknown as { pool: Pool }).pool;

describe('library user rename migration', () => {
  it('renames friend to zaur in place, so the id and everything it owns survive', async () => {
    const store = await makeLibrary();
    const pool = poolOf(store);

    // Stand in for an install that was seeded before the rename.
    await pool.query('UPDATE users SET username=?, display_name=? WHERE username=?', ['friend', 'Friend', 'zaur']);

    const before = await pool.query('SELECT id, username FROM users WHERE username=?', ['friend']);
    const oldId = (before as unknown as [{ id: number }[], unknown])[0][0].id;

    await migrateLibraryUsers(pool);

    const users = await store.listUsers();
    const zaur = users.find((u) => u.username === 'zaur');
    expect(zaur).toBeDefined();
    expect(zaur!.display_name).toBe('Zaur');
    // Same row, not a new one — this is the whole point of the migration.
    expect(zaur!.id).toBe(oldId);
    expect(users.some((u) => u.username === 'friend')).toBe(false);
  });

  it('is idempotent: running it twice changes nothing the second time', async () => {
    const store = await makeLibrary();
    const pool = poolOf(store);
    await migrateLibraryUsers(pool);
    await migrateLibraryUsers(pool);
    const users = await store.listUsers();
    expect(users.map((u) => u.username).sort()).toEqual(['artyom', 'zaur']);
  });

  it('refuses to rename into a name that is already taken, instead of colliding', async () => {
    const store = await makeLibrary();
    const pool = poolOf(store);
    await pool.query('UPDATE users SET username=? WHERE username=?', ['friend', 'zaur']);
    await pool.query('INSERT INTO users (username, display_name, created_at) VALUES (?,?,?)', [
      'zaur',
      'Someone Else',
      0,
    ]);

    await migrateLibraryUsers(pool);

    // The migration must leave both rows alone rather than violate uq_users_username.
    const rows = await pool.query('SELECT username FROM users ORDER BY id');
    const names = (rows as unknown as [{ username: string }[], unknown])[0].map((r) => r.username);
    expect(names).toContain('friend');
    expect(names.filter((n) => n === 'zaur')).toHaveLength(1);
  });
});
