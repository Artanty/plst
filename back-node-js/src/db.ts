import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { settings } from './config.js';
import { logger } from './lib/logger.js';
import { classifyDbError } from './lib/dbDiag.js';

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    mode VARCHAR(64) NOT NULL,
    source TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at DOUBLE NOT NULL DEFAULT 0,
    updated_at DOUBLE NOT NULL DEFAULT 0,
    total INT NOT NULL DEFAULT 0,
    processed INT NOT NULL DEFAULT 0,
    summary_json TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    collection_idx INT,
    position INT,
    src_title TEXT,
    src_artist TEXT,
    src_duration INT,
    status VARCHAR(32),
    score DOUBLE,
    yt_video_id VARCHAR(64),
    yt_title TEXT,
    yt_artist TEXT,
    yt_duration INT,
    collection_title TEXT,
    INDEX idx_items_job (job_id),
    CONSTRAINT fk_items_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS match_cache (
    \`key\` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    video_id VARCHAR(64),
    yt_title TEXT,
    yt_artist TEXT,
    yt_duration INT,
    score DOUBLE,
    created_at DOUBLE NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export interface JobRow {
  id: string;
  mode: string;
  source: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  total: number;
  processed: number;
  summary_json: string | null;
}

export interface ItemRow {
  job_id: string;
  collection_idx: number;
  position: number;
  src_title: string;
  src_artist: string;
  src_duration: number;
  status: string;
  score: number | null;
  yt_video_id: string | null;
  yt_title: string | null;
  yt_artist: string | null;
  yt_duration: number | null;
  collection_title: string | null;
}

export interface CacheRow {
  key: string;
  video_id: string;
  yt_title: string;
  yt_artist: string;
  yt_duration: number | null;
  score: number;
}

export class Store {
  private pool: mysql.Pool;

  constructor(pool: mysql.Pool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.pool.query(stmt);
    }
  }

  async createJob(mode: string, source: string): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = Date.now() / 1000;
    await this.pool.query('INSERT INTO jobs (id, mode, source, created_at, updated_at) VALUES (?,?,?,?,?)', [
      id, mode, source, now, now,
    ]);
    return id;
  }

  async setJob(id: string, fields: Partial<Record<'status' | 'error' | 'total' | 'processed' | 'summary_json', string | number | null>>): Promise<void> {
    const cols = Object.keys(fields);
    const assignments = cols.map((c) => `${c}=?`).join(', ');
    const values: (string | number | null)[] = [...Object.values(fields), Date.now() / 1000, id];
    await this.pool.query(`UPDATE jobs SET ${assignments}, updated_at=? WHERE id=?`, values);
  }

  async addTotal(id: string, delta: number): Promise<void> {
    await this.pool.query('UPDATE jobs SET total = total + ?, updated_at = ? WHERE id=?', [delta, Date.now() / 1000, id]);
  }

  async incProcessed(id: string): Promise<void> {
    await this.pool.query('UPDATE jobs SET processed = processed + 1, updated_at = ? WHERE id=?', [Date.now() / 1000, id]);
  }

  async addItems(rows: ItemRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => [
      r.job_id, r.collection_idx, r.position, r.src_title, r.src_artist, r.src_duration,
      r.status, r.score, r.yt_video_id, r.yt_title, r.yt_artist, r.yt_duration, r.collection_title,
    ]);
    await this.pool.query(
      `INSERT INTO items (job_id, collection_idx, position, src_title, src_artist, src_duration,
         status, score, yt_video_id, yt_title, yt_artist, yt_duration, collection_title) VALUES ?`,
      [values],
    );
  }

  async getJob(id: string): Promise<JobRow | null> {
    const [rows] = (await this.pool.query('SELECT * FROM jobs WHERE id=?', [id])) as unknown as [JobRow[], unknown];
    return rows[0] ?? null;
  }

  async listJobs(limit = 50): Promise<JobRow[]> {
    const [rows] = (await this.pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit])) as unknown as [JobRow[], unknown];
    return rows;
  }

  async jobItems(id: string): Promise<ItemRow[]> {
    const [rows] = (await this.pool.query('SELECT * FROM items WHERE job_id=? ORDER BY collection_idx, position', [id])) as unknown as [ItemRow[], unknown];
    return rows;
  }

  async cacheGet(key: string): Promise<CacheRow | null> {
    const [rows] = (await this.pool.query('SELECT * FROM match_cache WHERE `key`=?', [key])) as unknown as [CacheRow[], unknown];
    return rows[0] ?? null;
  }

  async cachePut(key: string, videoId: string, ytTitle: string, ytArtist: string, ytDuration: number | null, score: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO match_cache (\`key\`, video_id, yt_title, yt_artist, yt_duration, score, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         video_id = VALUES(video_id),
         yt_title = VALUES(yt_title),
         yt_artist = VALUES(yt_artist),
         yt_duration = VALUES(yt_duration),
         score = VALUES(score),
         created_at = VALUES(created_at)`,
      [key, videoId, ytTitle, ytArtist, ytDuration, score, Date.now() / 1000],
    );
  }
}

export function buildPool(): mysql.Pool {
  const pool = mysql.createPool({
    host: settings.dbHost ?? '127.0.0.1',
    port: settings.dbPort,
    database: settings.dbName ?? undefined,
    user: settings.dbUser ?? undefined,
    password: settings.dbPassword ?? undefined,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10_000,
    charset: 'utf8mb4',
  });
  // An idle connection that dies mid-run (the 2026-10-19 flap: down ~21:11, back by ~21:15) is
  // otherwise SILENT — the next query just fails and the error says nothing about the host. Note
  // the pool itself does NOT emit 'error' (mysql2 lib/base/pool.js only emits acquire/connection/
  // release/enqueue); the error lands on the CONNECTION, whose pool-registered handler merely
  // evicts it (lib/pool_connection.js: once('error') -> _removeFromPool). Attaching our own
  // listener on the 'connection' event — which the promise pool forwards — is the only place this
  // becomes visible. In-flight query failures still surface separately through the route handler;
  // this is the mid-run cause with host:port context. Names the layer + points at db:check, so a
  // runtime outage is as diagnosable as a boot one.
  pool.on('connection', (connection) => {
    connection.on('error', (err: NodeJS.ErrnoException) => {
      const verdict = classifyDbError(err, settings.dbHost ?? undefined);
      logger.error(`db: idle connection died — ${verdict.headline}`, err, 'buildPool');
      for (const action of verdict.actions.slice(0, 2)) {
        logger.log('db: what to do', { action: action.text, code: action.code ?? null }, 'buildPool');
      }
    });
  });
  return pool;
}

export async function openStore(): Promise<Store> {
  const store = new Store(buildPool());
  await store.init();
  return store;
}