import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { logger } from '../lib/logger.js';
import { albumKey, artistKey, songDedupKey } from './keys.js';
import type { MatchableSong } from './match.js';
import type {
  AlbumRow,
  ArtistRow,
  CollaboratorView,
  ImportRow,
  NotificationDTO,
  NotificationView,
  PlaylistRow,
  SongRow,
  UserRow,
} from './types.js';

export interface SeedUser {
  username: string;
  displayName: string;
}

/** One track, already trimmed and deduped within the scan, ready for the batched import phases. */
interface PreparedTrack {
  dkey: string;
  title: string;
  artists: string[];
  album: string | null;
  durationS: number;
}

/**
 * Two users, seeded. Sharing, permissions and notifications are unreachable with one user — a share
 * needs somebody to receive it — so the second exists purely to make those flows testable now, not
 * to imply an auth story that does not exist yet. There are NO passwords: the caller picks a user
 * with an x-user-id header.
 */
export const SEED_USERS: SeedUser[] = [
  { username: 'artyom', displayName: 'Artyom' },
  { username: 'zaur', displayName: 'Zaur' },
];

/** The non-row decorations a song needs before it can be displayed. */
export interface SongExtras {
  artists: { id: number; name: string; role: string }[];
  genres: { id: number; name: string; weight: number }[];
  album_title: string | null;
}

const EMPTY_EXTRAS: SongExtras = { artists: [], genres: [], album_title: null };

function now(): number {
  return Date.now() / 1000;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Rows per batched statement. Keeps every INSERT well under max_allowed_packet. */
const BATCH_ROWS = 200;

function chunks<T>(rows: T[], size = BATCH_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Sort a batch by its first column (always a dedup key). Every phase writes its rows in key order,
 * so two concurrent imports acquire the unique-index locks in the SAME order. Scan order — what
 * this code used before — differs per import, and that inversion is exactly what deadlocked.
 */
function byKey(a: readonly unknown[], b: readonly unknown[]): number {
  const ka = String(a[0]);
  const kb = String(b[0]);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function escapeLike(s: string): string {
  // Without this, a search for "100%" or "a_b" silently becomes a wildcard scan of the library.
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class LibraryStore {
  constructor(private pool: Pool) {}

  // ------------------------------------------------------------------ users

  async seedUsers(users: SeedUser[] = SEED_USERS): Promise<void> {
    for (const u of users) {
      await this.pool.query(
        'INSERT INTO users (username, display_name, created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)',
        [u.username, u.displayName, now()],
      );
    }
    logger.log('library: users seeded', { usernames: users.map((u) => u.username) });
  }

  async listUsers(): Promise<UserRow[]> {
    const [rows] = (await this.pool.query('SELECT id, username, display_name FROM users ORDER BY id')) as unknown as [UserRow[], unknown];
    return rows;
  }

  async getUser(id: number): Promise<UserRow | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const [rows] = (await this.pool.query('SELECT id, username, display_name FROM users WHERE id=?', [id])) as unknown as [UserRow[], unknown];
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------- scan

  /**
   * The import transaction: one connection, one commit.
   *
   * A half-imported scan — songs written but no import row, or an import row with no items — would
   * show up in the UI as a playlist silently missing tracks, which is the worst failure this
   * feature can have. So nothing commits unless all of it commits.
   *
   * This used to run one statement per track per artist (~4500 round trips for a 490-track scan)
   * inside that single transaction. Each `INSERT ... ON DUPLICATE KEY UPDATE` against a UNIQUE key
   * takes locks, so two concurrent imports over the same songs acquired them in conflicting order
   * and InnoDB resolved the cycle by killing one with ER_LOCK_DEADLOCK — a 500 the user saw on
   * "import to lib". Three things fix it, and all three matter:
   *   1. every write is BATCHED into multi-row statements, so the transaction is a handful of
   *      round trips instead of thousands — and a short transaction is a small window to collide in;
   *   2. the phases run in a FIXED order (artists -> albums -> songs -> artist_songs) with each
   *      phase sorted by dedup_key, so concurrent transactions take those locks in the same order
   *      and cannot form a cycle at all;
   *   3. a deadlock is still RETRIED on a fresh connection, because InnoDB picks a victim
   *      nondeterministically and its own message says to restart the transaction.
   *
   * `is_new` is decided by a pre-read of existing song keys inside the same transaction: a
   * multi-row upsert reports one affectedRows total, which cannot be attributed to individual rows
   * the way the old per-row `affectedRows === 1` could.
   */
  async importScan(opts: {
    userId: number;
    sourceLabel: string | null;
    pageUrl: string | null;
    tracks: { title: string; artists: string[]; album: string | null; durationS: number }[];
  }): Promise<{ importId: number; trackCount: number; newCount: number; dupCount: number; skippedCount: number }> {
    // Dedup WITHIN one scan: the DOM walk can surface the same rendered row twice, and
    // import_items is keyed (import_id, song_id) — a repeat would be a primary-key crash. Map
    // insertion order is the scan order, which is what import_items.position records, so the
    // sorted DB phases below must not disturb it.
    const seen = new Map<string, PreparedTrack>();
    let skipped = 0;
    for (const track of opts.tracks) {
      const artists = (track.artists.length ? track.artists : ['Unknown'])
        .map((a) => a.trim())
        .filter(Boolean);
      const dkey = songDedupKey(track.title, artists, track.durationS);
      if (seen.has(dkey)) {
        skipped += 1;
        continue;
      }
      seen.set(dkey, {
        dkey,
        title: track.title.trim(),
        artists,
        album: track.album?.trim() || null,
        durationS: track.durationS,
      });
    }
    const prepared = [...seen.values()];

    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.importScanOnce(opts.userId, opts.sourceLabel, opts.pageUrl, prepared, skipped);
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string }).code;
        const retryable = code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        // warn, not error: this is the retryable path doing its job, and an error line here would
        // read like a failed import when the import is still going to succeed.
        logger.warn('library: scan import hit a lock conflict, retrying', {
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          code,
          tracks: prepared.length,
        });
      }
    }
    throw lastErr; // unreachable; the loop either returns or throws
  }

  private async importScanOnce(
    userId: number,
    sourceLabel: string | null,
    pageUrl: string | null,
    prepared: PreparedTrack[],
    skipped: number,
  ): Promise<{ importId: number; trackCount: number; newCount: number; dupCount: number; skippedCount: number }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [importRes] = (await conn.query(
        'INSERT INTO imports (user_id, source, source_label, page_url, raw_count, track_count, created_at) VALUES (?,?,?,?,?,?,?)',
        [userId, 'yandex_scan', sourceLabel, pageUrl, prepared.length + skipped, 0, now()],
      )) as [ResultSetHeader, unknown];
      const importId = importRes.insertId;

      // Phase 1 — artists. Every phase sorts by dedup_key and writes its whole table at once, so
      // two concurrent imports acquire the unique-index locks in the SAME order.
      const artistByKey = new Map<string, string>(); // dedup_key -> display name
      for (const t of prepared) {
        for (const name of t.artists) {
          const k = artistKey(name);
          if (!artistByKey.has(k)) artistByKey.set(k, name);
        }
      }
      await this.batchUpsert(
        conn,
        'INSERT INTO artists (name, dedup_key) VALUES ? ON DUPLICATE KEY UPDATE name=name',
        [...artistByKey].sort(byKey).map(([key, name]) => [name, key]),
      );
      const artistId = await this.idMap(conn, 'artists', [...artistByKey.keys()]);

      // Phase 2 — albums. Keyed on (title, owning artist id, year), so this cannot run before the
      // artist ids exist.
      const albumByKey = new Map<string, { title: string; artistId: number | null }>();
      for (const t of prepared) {
        if (!t.album) continue;
        const aid = t.artists.length ? (artistId.get(artistKey(t.artists[0])) ?? null) : null;
        const k = albumKey(t.album, aid, null);
        if (!albumByKey.has(k)) albumByKey.set(k, { title: t.album, artistId: aid });
      }
      await this.batchUpsert(
        conn,
        'INSERT INTO albums (title, artist_id, year, dedup_key) VALUES ? ON DUPLICATE KEY UPDATE title=title',
        [...albumByKey].sort(byKey).map(([key, a]) => [a.title, a.artistId, null, key]),
      );
      const albumId = await this.idMap(conn, 'albums', [...albumByKey.keys()]);

      // Phase 3 — songs. The pre-read below is what `is_new` is computed from.
      const existing = await this.idMap(conn, 'songs', prepared.map((t) => t.dkey));
      const seenAt = now();
      await this.batchUpsert(
        conn,
        `INSERT INTO songs (dedup_key, title, duration_s, album_id, first_seen_at, last_seen_at, seen_count)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           last_seen_at = VALUES(last_seen_at),
           seen_count   = seen_count + 1,
           play_count   = play_count + 1,
           album_id     = COALESCE(songs.album_id, VALUES(album_id))`,
        prepared
          .map((t) => {
            const aid = t.artists.length ? (artistId.get(artistKey(t.artists[0])) ?? null) : null;
            const alb = t.album ? (albumId.get(albumKey(t.album, aid, null)) ?? null) : null;
            return [t.dkey, t.title, t.durationS, alb, seenAt, seenAt, 1] as unknown[];
          })
          .sort(byKey),
      );
      const songId = await this.idMap(conn, 'songs', prepared.map((t) => t.dkey));

      // Phase 4 — artist_songs (PK song_id, artist_id), sorted on that same key.
      const linkRows: unknown[][] = [];
      for (const t of prepared) {
        const sid = songId.get(t.dkey);
        if (sid === undefined) throw new Error(`song disappeared right after upsert (${t.dkey})`);
        t.artists.forEach((name, i) => {
          const aid = artistId.get(artistKey(name));
          if (aid === undefined) return;
          linkRows.push([sid, aid, i, i === 0 ? 'main' : 'feat']);
        });
      }
      await this.batchUpsert(
        conn,
        'INSERT INTO artist_songs (song_id, artist_id, position, role) VALUES ? ON DUPLICATE KEY UPDATE position=VALUES(position), role=VALUES(role)',
        linkRows.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1])),
      );

      // import_items keeps SCAN order, not sorted order: position is the order the user saw.
      if (prepared.length) {
        const values = prepared.map((t, i) => [importId, songId.get(t.dkey), i, existing.has(t.dkey) ? 0 : 1]);
        for (const chunk of chunks(values)) {
          await conn.query('INSERT INTO import_items (import_id, song_id, position, is_new) VALUES ?', [chunk]);
        }
      }

      const newCount = prepared.filter((t) => !existing.has(t.dkey)).length;
      await conn.query('UPDATE imports SET track_count=?, new_song_count=?, skipped_count=? WHERE id=?', [
        prepared.length,
        newCount,
        skipped,
        importId,
      ]);
      await conn.commit();

      logger.log('library: scan imported', { importId, userId, tracks: prepared.length, newCount, skipped });
      return {
        importId,
        trackCount: prepared.length,
        newCount,
        dupCount: prepared.length - newCount,
        skippedCount: skipped,
      };
    } catch (err) {
      await conn.rollback();
      logger.error('library: scan import failed', err, 'library.importScan');
      throw err;
    } finally {
      conn.release();
    }
  }

  /** One multi-row upsert, chunked so a 5000-track scan cannot exceed max_allowed_packet. */
  private async batchUpsert(conn: PoolConnection, sql: string, rows: unknown[][]): Promise<void> {
    for (const chunk of chunks(rows)) {
      if (chunk.length) await conn.query(sql, [chunk]);
    }
  }

  /** dedup_key -> id for whichever of `keys` exist. Missing keys are simply absent. */
  private async idMap(conn: PoolConnection, table: 'songs' | 'artists' | 'albums', keys: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const chunk of chunks([...new Set(keys)])) {
      const [rows] = (await conn.query(
        `SELECT id, dedup_key FROM ${table} WHERE dedup_key IN (${placeholders(chunk.length)})`,
        chunk,
      )) as unknown as [(RowDataPacket & { id: number; dedup_key: string })[], unknown];
      for (const r of rows) out.set(r.dedup_key, r.id);
    }
    return out;
  }

  // ---------------------------------------------------------------- imports

  async pendingImports(userId: number): Promise<(ImportRow & { item_count: number })[]> {
    const [rows] = (await this.pool.query(
      `SELECT i.*, (SELECT COUNT(*) FROM import_items ii WHERE ii.import_id = i.id) AS item_count
       FROM imports i
       WHERE i.user_id = ? AND i.is_processed = 0
       ORDER BY i.id DESC`,
      [userId],
    )) as unknown as [(ImportRow & { item_count: number })[], unknown];
    return rows.map((r) => ({ ...r, item_count: Number(r.item_count) }));
  }

  async pendingImportCount(userId: number): Promise<number> {
    const [rows] = (await this.pool.query(
      'SELECT COUNT(*) AS n FROM imports WHERE user_id=? AND is_processed=0',
      [userId],
    )) as unknown as [(RowDataPacket & { n: number })[], unknown];
    return Number(rows[0]?.n ?? 0);
  }

  async getImport(id: number): Promise<ImportRow | null> {
    const [rows] = (await this.pool.query('SELECT * FROM imports WHERE id=?', [id])) as unknown as [ImportRow[], unknown];
    return rows[0] ?? null;
  }

  async importItemSongIds(importId: number, limit = 5000, offset = 0): Promise<number[]> {
    const [rows] = (await this.pool.query(
      'SELECT song_id FROM import_items WHERE import_id=? ORDER BY position, song_id LIMIT ? OFFSET ?',
      [importId, limit, offset],
    )) as unknown as [{ song_id: number }[], unknown];
    return rows.map((r) => r.song_id);
  }

  async importNewSongIds(importId: number): Promise<number[]> {
    const [rows] = (await this.pool.query(
      'SELECT song_id FROM import_items WHERE import_id=? AND is_new=1 ORDER BY position',
      [importId],
    )) as unknown as [{ song_id: number }[], unknown];
    return rows.map((r) => r.song_id);
  }

  async markImportProcessed(importId: number, playlistId: number): Promise<void> {
    await this.pool.query('UPDATE imports SET is_processed=1, playlist_id=?, processed_at=? WHERE id=?', [playlistId, now(), importId]);
  }

  // ------------------------------------------------------------------ songs

  async searchSongs(params: {
    q?: string;
    albumId?: number;
    artistId?: number;
    genreId?: number;
    limit: number;
    offset: number;
  }): Promise<{ total: number; rows: SongRow[] }> {
    const where: string[] = [];
    const args: unknown[] = [];

    if (params.q?.trim()) {
      // Title OR any of its artists — the two things a human actually remembers. Matching only the
      // start of the string would hide "Roxanne" when the user typed "rox"… this is a substring.
      where.push(`(s.title LIKE ? ESCAPE '\\\\' OR EXISTS (
        SELECT 1 FROM artist_songs x JOIN artists a ON a.id = x.artist_id
        WHERE x.song_id = s.id AND a.name LIKE ? ESCAPE '\\\\'))`);
      const like = `%${escapeLike(params.q.trim())}%`;
      args.push(like, like);
    }
    if (params.albumId) {
      where.push('s.album_id = ?');
      args.push(params.albumId);
    }
    if (params.artistId) {
      where.push('EXISTS (SELECT 1 FROM artist_songs x WHERE x.song_id = s.id AND x.artist_id = ?)');
      args.push(params.artistId);
    }
    if (params.genreId) {
      where.push('EXISTS (SELECT 1 FROM song_genres x WHERE x.song_id = s.id AND x.genre_id = ?)');
      args.push(params.genreId);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = (await this.pool.query(`SELECT COUNT(*) AS n FROM songs s ${clause}`, args)) as unknown as [
      (RowDataPacket & { n: number })[],
      unknown,
    ];
    const [rows] = (await this.pool.query(`SELECT s.* FROM songs s ${clause} ORDER BY s.title LIMIT ? OFFSET ?`, [
      ...args,
      params.limit,
      params.offset,
    ])) as unknown as [SongRow[], unknown];

    return { total: Number(countRows[0]?.n ?? 0), rows };
  }

  /**
   * One batched pass for a whole page of songs: three IN-clauses instead of three queries per row.
   * At 200 rows per page that is 600 round-trips collapsed into 3.
   *
   * Takes the songs themselves rather than bare ids so album_id is already in hand — passing ids
   * would force a fourth query to read back a column the caller is already holding.
   */
  async songExtras(songs: SongRow[]): Promise<Map<number, SongExtras>> {
    const ids = songs.map((s) => s.id);
    const out = new Map<number, SongExtras>();
    for (const s of songs) out.set(s.id, { artists: [], genres: [], album_title: null });
    if (!ids.length) return out;

    const ph = placeholders(ids.length);
    const [artists] = (await this.pool.query(
      `SELECT x.song_id, a.id, a.name, x.role
       FROM artist_songs x JOIN artists a ON a.id = x.artist_id
       WHERE x.song_id IN (${ph}) ORDER BY x.position, a.name`,
      ids,
    )) as unknown as [{ song_id: number; id: number; name: string; role: string }[], unknown];
    for (const a of artists) out.get(a.song_id)?.artists.push({ id: a.id, name: a.name, role: a.role });

    const [genres] = (await this.pool.query(
      `SELECT sg.song_id, g.id, g.name, sg.weight
       FROM song_genres sg JOIN genres g ON g.id = sg.genre_id
       WHERE sg.song_id IN (${ph}) ORDER BY sg.weight DESC, g.name`,
      ids,
    )) as unknown as [{ song_id: number; id: number; name: string; weight: number }[], unknown];
    for (const g of genres) out.get(g.song_id)?.genres.push({ id: g.id, name: g.name, weight: g.weight });

    const albumIds = [...new Set(songs.map((s) => s.album_id).filter((v): v is number => v !== null))];
    if (albumIds.length) {
      const [albums] = (await this.pool.query(
        `SELECT id, title FROM albums WHERE id IN (${placeholders(albumIds.length)})`,
        albumIds,
      )) as unknown as [AlbumRow[], unknown];
      const titleById = new Map(albums.map((a) => [a.id, a.title]));
      for (const s of songs) {
        if (s.album_id !== null) out.get(s.id)!.album_title = titleById.get(s.album_id) ?? null;
      }
    }

    return out;
  }


  private async albumIdsOf(ids: number[]): Promise<{ song_id: number; album_id: number | null }[]> {
    const ph = placeholders(ids.length);
    const [rows] = (await this.pool.query(`SELECT id AS song_id, album_id FROM songs WHERE id IN (${ph})`, ids)) as unknown as [
      { song_id: number; album_id: number | null }[],
      unknown,
    ];
    return rows;
  }

  async getSong(id: number): Promise<SongRow | null> {
    const [rows] = (await this.pool.query('SELECT * FROM songs WHERE id=?', [id])) as unknown as [SongRow[], unknown];
    return rows[0] ?? null;
  }

  /** Fetch many songs at once, preserving the caller's id order. Replaces a per-row getSong() loop. */
  async songsByIds(ids: number[]): Promise<SongRow[]> {
    if (!ids.length) return [];
    const [rows] = (await this.pool.query(`SELECT * FROM songs WHERE id IN (${placeholders(ids.length)})`, ids)) as unknown as [
      SongRow[],
      unknown,
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    // A playlist may hold the same song twice; order and length must survive that.
    return ids.map((id) => byId.get(id)).filter((s): s is SongRow => Boolean(s));
  }

  async listArtists(limit = 300): Promise<ArtistRow[]> {
    const [rows] = (await this.pool.query(
      `SELECT a.id, a.name FROM artists a
       ORDER BY (SELECT COUNT(*) FROM artist_songs x WHERE x.artist_id = a.id) DESC, a.name LIMIT ?`,
      [limit],
    )) as unknown as [ArtistRow[], unknown];
    return rows;
  }

  async listAlbums(limit = 300): Promise<(AlbumRow & { song_count: number })[]> {
    const [rows] = (await this.pool.query(
      `SELECT al.id, al.title, al.artist_id, al.year,
              (SELECT COUNT(*) FROM songs s WHERE s.album_id = al.id) AS song_count
       FROM albums al ORDER BY al.title LIMIT ?`,
      [limit],
    )) as unknown as [(AlbumRow & { song_count: number })[], unknown];
    return rows.map((r) => ({ ...r, song_count: Number(r.song_count) }));
  }

  async listGenres(): Promise<{ id: number; name: string; song_count: number }[]> {
    const [rows] = (await this.pool.query(
      `SELECT g.id, g.name, (SELECT COUNT(*) FROM song_genres sg WHERE sg.genre_id = g.id) AS song_count
       FROM genres g ORDER BY g.name`,
    )) as unknown as [{ id: number; name: string; song_count: number }[], unknown];
    return rows.map((r) => ({ ...r, song_count: Number(r.song_count) }));
  }

  // -------------------------------------------------------------- playlists

  async createPlaylist(ownerId: number, name: string, description: string | null): Promise<number> {
    const t = now();
    const [res] = (await this.pool.query('INSERT INTO playlists (owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)', [
      ownerId,
      name,
      description,
      t,
      t,
    ])) as [ResultSetHeader, unknown];
    return res.insertId;
  }

  /**
   * Create a playlist and optionally fill it, in ONE transaction. The UI calls this for "make a
   * playlist from these library songs": doing it as create-then-add over HTTP would leave an empty
   * playlist behind whenever the second call failed, which is exactly the mess a user would then
   * have to clean up by hand.
   */
  async createPlaylistWithSongs(
    ownerId: number,
    name: string,
    description: string | null,
    songIds: number[],
  ): Promise<{ playlistId: number; added: number }> {
    if (!songIds.length) return { playlistId: await this.createPlaylist(ownerId, name, description), added: 0 };

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const t = now();
      const [res] = (await conn.query(
        'INSERT INTO playlists (owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)',
        [ownerId, name, description, t, t],
      )) as [ResultSetHeader, unknown];
      const playlistId = res.insertId;

      const values = songIds.map((songId, i) => [playlistId, songId, i, ownerId, t]);
      await conn.query('INSERT INTO playlist_items (playlist_id, song_id, position, added_by, added_at) VALUES ?', [
        values,
      ]);
      await conn.commit();
      return { playlistId, added: values.length };
    } catch (err) {
      // Without this the playlist row survives a failed item insert and the user gets an empty one.
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async getPlaylist(id: number): Promise<PlaylistRow | null> {
    const [rows] = (await this.pool.query('SELECT * FROM playlists WHERE id=?', [id])) as unknown as [PlaylistRow[], unknown];
    return rows[0] ?? null;
  }

  async updatePlaylist(id: number, fields: { name?: string; description?: string | null }): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name=?');
      args.push(fields.name);
    }
    if (fields.description !== undefined) {
      sets.push('description=?');
      args.push(fields.description);
    }
    if (!sets.length) return;
    sets.push('updated_at=?');
    args.push(now(), id);
    await this.pool.query(`UPDATE playlists SET ${sets.join(', ')} WHERE id=?`, args);
  }

  /** Cascades to playlist_items, collaborators and notifications. Songs are deliberately NOT touched. */
  async deletePlaylist(id: number): Promise<void> {
    await this.pool.query('DELETE FROM playlists WHERE id=?', [id]);
  }

  async listPlaylistsForUser(userId: number): Promise<
    (PlaylistRow & { owner_username: string; item_count: number; can_edit: boolean; shared_with_me: boolean })[]
  > {
    const [rows] = (await this.pool.query(
      `SELECT p.*, u.username AS owner_username,
              (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
              (p.owner_id = ?) AS is_owner,
              (SELECT pc.can_edit FROM playlist_collaborators pc WHERE pc.playlist_id = p.id AND pc.user_id = ?) AS collab_can_edit,
              EXISTS(SELECT 1 FROM playlist_collaborators pc2
                     WHERE pc2.playlist_id = p.id AND pc2.user_id = ?) AS shared_with_me
       FROM playlists p JOIN users u ON u.id = p.owner_id
       WHERE p.owner_id = ? OR EXISTS(SELECT 1 FROM playlist_collaborators pc3
                                      WHERE pc3.playlist_id = p.id AND pc3.user_id = ?)
       ORDER BY p.updated_at DESC, p.id DESC`,
      [userId, userId, userId, userId, userId],
    )) as unknown as [
      (PlaylistRow & {
        owner_username: string;
        item_count: number;
        is_owner: number;
        collab_can_edit: number | null;
        shared_with_me: number;
      })[],
      unknown,
    ];
    return rows.map((r) => ({
      id: r.id,
      owner_id: r.owner_id,
      name: r.name,
      description: r.description,
      created_at: r.created_at,
      updated_at: r.updated_at,
      owner_username: r.owner_username,
      item_count: Number(r.item_count),
      can_edit: Boolean(r.is_owner) || Boolean(r.collab_can_edit),
      shared_with_me: Boolean(r.shared_with_me),
    }));
  }

  async listCollaborators(playlistId: number): Promise<CollaboratorView[]> {
    const [rows] = (await this.pool.query(
      `SELECT pc.user_id, u.username, u.display_name, pc.can_edit, pc.shared_at
       FROM playlist_collaborators pc JOIN users u ON u.id = pc.user_id
       WHERE pc.playlist_id = ? ORDER BY pc.shared_at`,
      [playlistId],
    )) as unknown as [{ user_id: number; username: string; display_name: string; can_edit: number; shared_at: number }[], unknown];
    return rows.map((r) => ({ ...r, can_edit: Boolean(r.can_edit) }));
  }

  async sharePlaylist(playlistId: number, userId: number, canEdit: boolean, sharedBy: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO playlist_collaborators (playlist_id, user_id, can_edit, shared_by, shared_at)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE can_edit = VALUES(can_edit), shared_by = VALUES(shared_by), shared_at = VALUES(shared_at)`,
      [playlistId, userId, canEdit ? 1 : 0, sharedBy, now()],
    );
  }

  async unsharePlaylist(playlistId: number, userId: number): Promise<void> {
    await this.pool.query('DELETE FROM playlist_collaborators WHERE playlist_id=? AND user_id=?', [playlistId, userId]);
  }

  async collaboratorIds(playlistId: number): Promise<number[]> {
    const [rows] = (await this.pool.query('SELECT user_id FROM playlist_collaborators WHERE playlist_id=?', [playlistId])) as unknown as [
      { user_id: number }[],
      unknown,
    ];
    return rows.map((r) => r.user_id);
  }

  // --------------------------------------------------------- playlist items

  async addPlaylistItems(playlistId: number, songIds: number[], addedBy: number): Promise<number> {
    if (!songIds.length) return 0;
    const [posRows] = (await this.pool.query(
      'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id=?',
      [playlistId],
    )) as unknown as [(RowDataPacket & { m: number })[], unknown];
    let pos = Number(posRows[0]?.m ?? -1) + 1;
    const t = now();
    const values = songIds.map((songId) => [playlistId, songId, pos++, addedBy, t]);
    await this.pool.query('INSERT INTO playlist_items (playlist_id, song_id, position, added_by, added_at) VALUES ?', [values]);
    await this.pool.query('UPDATE playlists SET updated_at=? WHERE id=?', [t, playlistId]);
    return values.length;
  }

  async removePlaylistItem(itemId: number, playlistId: number): Promise<boolean> {
    const [res] = (await this.pool.query('DELETE FROM playlist_items WHERE id=? AND playlist_id=?', [itemId, playlistId])) as [
      ResultSetHeader,
      unknown,
    ];
    await this.pool.query('UPDATE playlists SET updated_at=? WHERE id=?', [now(), playlistId]);
    return res.affectedRows > 0;
  }

  async playlistItemRows(playlistId: number): Promise<
    { id: number; song_id: number; position: number; added_by: number; added_at: number; added_by_username: string }[]
  > {
    const [rows] = (await this.pool.query(
      `SELECT pi.id, pi.song_id, pi.position, pi.added_by, pi.added_at, u.username AS added_by_username
       FROM playlist_items pi JOIN users u ON u.id = pi.added_by
       WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id`,
      [playlistId],
    )) as unknown as [
      { id: number; song_id: number; position: number; added_by: number; added_at: number; added_by_username: string }[],
      unknown,
    ];
    return rows;
  }

  async existingSongIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const [rows] = (await this.pool.query(`SELECT id FROM songs WHERE id IN (${placeholders(ids.length)})`, ids)) as unknown as [
      { id: number }[],
      unknown,
    ];
    return new Set(rows.map((r) => r.id));
  }

  // ------------------------------------------------------ youtube matching

  /**
   * Song rows in the shape the matcher wants, with artists resolved. The matcher needs the artist
   * names as a list because a Yandex track can credit several, and a comma-joined string could not
   * be re-split reliably (see the artist_songs comment in schema.ts).
   */
  async matchableSongs(ids: number[]): Promise<MatchableSong[]> {
    const songs = await this.songsByIds(ids);
    if (!songs.length) return [];
    const extras = await this.songExtras(songs);
    return songs.map((s) => ({
      id: s.id,
      title: s.title,
      artists: (extras.get(s.id)?.artists ?? []).map((a) => a.name),
      album: extras.get(s.id)?.album_title ?? null,
      duration: s.duration_s,
      yt_video_id: s.yt_video_id,
      match_score: s.match_score,
      match_status: s.match_status,
    }));
  }

  /**
   * Persist a match. A null videoId stores the attempt as "tried, found nothing" so a re-match is
   * still possible. match_status carries the VERDICT, which (videoId=null, score=0) alone cannot
   * express: 'search_failed' means YouTube was never reached (dead proxy) and the song deserves a
   * retry once the network works, while 'not_found' is a real answer that a retry would repeat.
   */
  async setSongMatch(songId: number, videoId: string | null, score: number, status: string): Promise<void> {
    await this.pool.query('UPDATE songs SET yt_video_id=?, match_score=?, match_status=?, matched_at=? WHERE id=?', [
      videoId,
      score,
      status,
      now(),
      songId,
    ]);
  }

  /** Playlist songs in playlist order, ready to match or export. */
  async playlistSongsForLinks(playlistId: number): Promise<MatchableSong[]> {
    const [rows] = (await this.pool.query('SELECT song_id FROM playlist_items WHERE playlist_id=? ORDER BY position, id', [
      playlistId,
    ])) as unknown as [{ song_id: number }[], unknown];
    return this.matchableSongs(rows.map((r) => r.song_id));
  }

  async songIdsForExport(ids: number[]): Promise<number[]> {
    return (await this.songsByIds(ids)).map((s) => s.id);
  }

  // --------------------------------------------------------- notifications

  async notify(n: {
    userId: number;
    type: string;
    actorId?: number | null;
    playlistId?: number | null;
    importId?: number | null;
    payload?: unknown;
  }): Promise<void> {
    await this.pool.query(
      'INSERT INTO notifications (user_id, type, actor_id, playlist_id, import_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
      [n.userId, n.type, n.actorId ?? null, n.playlistId ?? null, n.importId ?? null, n.payload ? JSON.stringify(n.payload) : null, now()],
    );
  }

  /**
   * Notify every participant EXCEPT the actor. This is the single place the exclusion is expressed,
   * so no route can accidentally ping you about your own click.
   */
  async notifyParticipants(opts: {
    playlistId: number;
    actorId: number;
    ownerId: number;
    type: string;
    payload?: unknown;
  }): Promise<number> {
    const ids = new Set<number>(await this.collaboratorIds(opts.playlistId));
    ids.add(opts.ownerId);
    ids.delete(opts.actorId);
    for (const userId of ids) {
      await this.notify({ userId, type: opts.type, actorId: opts.actorId, playlistId: opts.playlistId, payload: opts.payload });
    }
    return ids.size;
  }

  async listNotifications(userId: number, limit = 50): Promise<NotificationDTO[]> {
    const [rows] = (await this.pool.query(
      `SELECT n.id, n.user_id, n.type, n.actor_id, n.playlist_id, n.import_id, n.payload_json, n.is_read, n.created_at,
              a.username AS actor_username, p.name AS playlist_name
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN playlists p ON p.id = n.playlist_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`,
      [userId, limit],
    )) as unknown as [NotificationView[], unknown];
    return rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      type: r.type,
      actor_id: r.actor_id,
      playlist_id: r.playlist_id,
      import_id: r.import_id,
      created_at: r.created_at,
      actor_username: r.actor_username,
      playlist_name: r.playlist_name,
      is_read: Boolean(r.is_read),
      payload: r.payload_json ? safeParse(r.payload_json) : null,
    }));
  }

  async unreadNotificationCount(userId: number): Promise<number> {
    const [rows] = (await this.pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0', [userId])) as unknown as [
      (RowDataPacket & { n: number })[],
      unknown,
    ];
    return Number(rows[0]?.n ?? 0);
  }

  async markNotificationsRead(userId: number, ids: number[] | null): Promise<number> {
    if (ids?.length) {
      const [res] = (await this.pool.query(
        `UPDATE notifications SET is_read=1 WHERE user_id=? AND id IN (${placeholders(ids.length)})`,
        [userId, ...ids],
      )) as [ResultSetHeader, unknown];
      return res.affectedRows;
    }
    const [res] = (await this.pool.query('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0', [userId])) as [
      ResultSetHeader,
      unknown,
    ];
    return res.affectedRows;
  }
}

export { EMPTY_EXTRAS };
