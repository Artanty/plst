import mysql from 'mysql2/promise';
import { Store } from '../src/db.js';
import { initLibrary } from '../src/library/schema.js';
import { LibraryStore } from '../src/library/store.js';

export async function makeStore(): Promise<Store> {
  const testDb = `plst_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
  });
  await conn.query(`CREATE DATABASE \`${testDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();

  const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: testDb,
    connectionLimit: 5,
  });
  const store = new Store(pool);
  await store.init();
  return store;
}

/** Same throwaway database, with the library schema created on it. */
const libraryDbs: string[] = [];

export async function makeLibrary(): Promise<LibraryStore> {
  const testDb = `plst_lib_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
  });
  await conn.query(`CREATE DATABASE \`${testDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  libraryDbs.push(testDb);

  const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: testDb,
    connectionLimit: 5,
  });
  await initLibrary(pool);
  const store = new LibraryStore(pool);
  await store.seedUsers();
  return store;
}

/**
 * Drop everything makeLibrary created. Each test needs its own database (the seed users and songs
 * would otherwise leak between cases), but nothing was dropping them — 16 orphaned schemas per run.
 * Called from afterAll in library.test.ts.
 */
export async function cleanupLibraryDatabases(): Promise<void> {
  const names = libraryDbs.splice(0, libraryDbs.length);
  if (!names.length) return;
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
  for (const name of names) await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.end();
}