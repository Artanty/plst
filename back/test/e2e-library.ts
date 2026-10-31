import mysql from 'mysql2/promise';
import { buildPool } from '../src/db.js';
import { initLibrary } from '../src/library/schema.js';
import { LibraryStore } from '../src/library/store.js';
import { buildApp } from '../src/server.js';
import { Store } from '../src/db.js';

// Boots the real Fastify app against a throwaway local DB and walks the whole HTTP surface the way
// the extension and the Angular app will. Lives in test/ but is run by hand:
//   npx tsx test/e2e-library.ts
// Why not vitest: it needs a real listening socket (to prove CORS and the actual wire format the
// extension posts), and a fixed port, which does not belong in the unit suite.

const DB = `plst_e2e_${Date.now()}`;

async function main() {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
  await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  const pool = mysql.createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: '', database: DB, connectionLimit: 5 });
  await initLibrary(pool);
  const library = new LibraryStore(pool);
  await library.seedUsers();

  const plstPool = buildPool();
  const plstStore = new Store(plstPool);
  await plstStore.init();

  const app = buildApp(plstStore, library);
  const port = 8123;
  await app.listen({ host: '127.0.0.1', port });
  const base = `http://127.0.0.1:${port}/api/library`;
  const call = async (method: string, path: string, body?: unknown, userId?: number) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(userId ? { 'x-user-id': String(userId) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json', origin: 'http://localhost:4200' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text error */
    }
    return { status: res.status, json, text, cors: res.headers.get('access-control-allow-origin') };
  };

  const check = (name: string, ok: boolean, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) process.exitCode = 1;
  };

  // 1. the extension's real payload shape (content.js emits {title, artists[], album, durationS})
  const scan = await call('POST', '/scan', {
    userId: 1,
    pageUrl: 'https://music.yandex.ru/playlists/abc',
    tracks: [
      { title: 'Roxanne', artists: ['The Police'], album: 'Outlandos', durationS: 300 },
      { title: 'So Lonely', artists: ['The Police'], album: 'Outlandos', durationS: 198 },
      { title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams'], album: 'Random Access Memories', durationS: 369 },
    ],
  });
  check('POST /scan 200', scan.status === 200, JSON.stringify(scan.json));
  check('scan reports 3 new', (scan.json as { newCount: number }).newCount === 3);
  check('CORS header present for the ng dev origin', scan.cors === 'http://localhost:4200', String(scan.cors));
  const importId = (scan.json as { importId: number }).importId;

  // 2. the pending-queue banner the user asked for
  const me = await call('GET', '/me', undefined, 1);
  check('GET /me pendingImports=1', (me.json as { pendingImports: number }).pendingImports === 1, JSON.stringify(me.json));
  const noHeader = await call('GET', '/me');
  check('GET /me without x-user-id is a clear 400', noHeader.status === 400, noHeader.text);

  // 3. turning the import into a playlist
  const built = await call('POST', `/imports/${importId}/playlist`, { name: 'My scan' }, 1);
  check('POST /imports/:id/playlist 200', built.status === 200, JSON.stringify(built.json));
  const playlistId = (built.json as { playlistId: number }).playlistId;
  check('import is no longer pending', (await call('GET', '/me', undefined, 1)).json!.pendingImports === 0);

  // 4. sharing -> the other user gets a notification
  const shared = await call('POST', `/playlists/${playlistId}/share`, { userId: 2, canEdit: true }, 1);
  check('POST /share 200', shared.status === 200, JSON.stringify(shared.json));
  const otherMe = await call('GET', '/me', undefined, 2);
  check('user 2 sees 1 unread notification', (otherMe.json as { unreadNotifications: number }).unreadNotifications === 1, JSON.stringify(otherMe.json));

  // 5. the collaborator edits; the OWNER hears about it
  const added = await call('POST', `/playlists/${playlistId}/items`, { songIds: [1] }, 2);
  check('collaborator with canEdit may add tracks', added.status === 200, JSON.stringify(added.json));
  const ownerNotifs = await call('GET', '/notifications', undefined, 1);
  check('owner was notified of the collaborator edit', (ownerNotifs.json as { notifications: { type: string }[] }).notifications.some((n) => n.type === 'playlist_edited'), JSON.stringify(ownerNotifs.json));
  check('actor did NOT notify themselves', (ownerNotifs.json as { notifications: unknown[] }).notifications.every((n) => (n as { actor_username: string }).actor_username === 'zaur'));

  // 6. view-only cannot edit
  await call('POST', `/playlists/${playlistId}/share`, { userId: 2, canEdit: false }, 1);
  const denied = await call('POST', `/playlists/${playlistId}/items`, { songIds: [1] }, 2);
  check('view-only collaborator gets 403 on edit', denied.status === 403, denied.text);

  // 7. a stranger gets 404, not 403 (do not confirm the playlist exists)
  await pool.query("INSERT INTO users (username, display_name, created_at) VALUES ('nobody','Nobody',0)");
  const stranger = await call('GET', `/playlists/${playlistId}`, undefined, 3);
  check('a non-collaborator gets 404, not 403', stranger.status === 404, stranger.text);

  // 8. search + facets
  const found = await call('GET', '/songs?q=police', undefined, 1);
  check('search by artist finds 2', (found.json as { total: number }).total === 2, JSON.stringify(found.json));
  const genres = await call('GET', '/genres', undefined, 1);
  check('GET /genres works while empty', (genres.json as { genres: unknown[] }).genres.length === 0);

  // 9. a second user scans the SAME songs: no duplicate songs, their own import row
  const scan2 = await call('POST', '/scan', { userId: 2, tracks: [{ title: 'Roxanne', artists: ['The Police'], album: 'Outlandos', durationS: 300 }] });
  check('rescanning from another user adds 0 new songs', (scan2.json as { newCount: number }).newCount === 0);
  check('library still has exactly 3 songs', ((await call('GET', '/songs', undefined, 1)).json as { total: number }).total === 3);
  check('but user 2 gets their own pending import', ((await call('GET', '/me', undefined, 2)).json as { pendingImports: number }).pendingImports === 1);

  // 10. deleting a playlist keeps the songs
  await call('DELETE', `/playlists/${playlistId}`, undefined, 1);
  check('songs survive playlist deletion', ((await call('GET', '/songs', undefined, 1)).json as { total: number }).total === 3);

  await app.close();
  // The pool still holds the only connections to DB, so drop it through `conn` (which is not bound
  // to a schema). Dropping twice — once via pool, once via conn — is the mistake this replaced.
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await pool.end();
  await plstPool.end();
  await conn.end();
  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
