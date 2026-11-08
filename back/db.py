"""MySQL access — pool + the legacy converter Store (jobs / items / match_cache).

Port of back-node-js/src/db.ts. PyMySQL + DBUtils PooledDB stand in for mysql2's pool;
`fetchall`/`execute` mirror the two shapes the node code used (`[rows]` + affected info).
Placeholder style is %(name)s — call sites use dict params.
"""
import time
import uuid

import pymysql
from dbutils.pooled_db import PooledDB

from config import settings
from lib.db_diag import classify_db_error
from lib.logger import logger

SCHEMA_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS jobs (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE IF NOT EXISTS items (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE IF NOT EXISTS match_cache (
    `key` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    video_id VARCHAR(64),
    yt_title TEXT,
    yt_artist TEXT,
    yt_duration INT,
    score DOUBLE,
    created_at DOUBLE NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
]


def now() -> float:
    return time.time()


class Database:
    """The pool + thin query helpers. Rows come back as dicts (cursor DictCursor)."""

    def __init__(self, pool=None):
        self.pool = pool or self._build_pool()

    def _build_pool(self) -> PooledDB:
        # Idle connections that die mid-run are otherwise silent in PyMySQL too; PooledDB's
        # ping=1 reconnects transparently on checkout, and in-flight failures surface through
        # the route handler. (The node build logged per-connection deaths — with ping=1 the
        # same flap self-heals, so there is nothing to log per connection here.)
        return PooledDB(
            creator=pymysql,
            maxconnections=10,
            ping=1,
            connect_timeout=10,
            charset="utf8mb4",
            host=settings.db_host or "127.0.0.1",
            port=settings.db_port,
            database=settings.db_name,
            user=settings.db_user,
            password=settings.db_password,
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
        )

    def execute(self, sql: str, params=None) -> int:
        """Run a statement; return lastrowid if any, else affected row count."""
        conn = self.pool.connection()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params or ())
                return cur.lastrowid if cur.lastrowid else cur.rowcount
        finally:
            conn.close()

    def fetchall(self, sql: str, params=None) -> list[dict]:
        conn = self.pool.connection()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params or ())
                return list(cur.fetchall())
        finally:
            conn.close()

    def fetchone(self, sql: str, params=None) -> dict | None:
        rows = self.fetchall(sql, params)
        return rows[0] if rows else None

    def transaction(self):
        """Context manager for an explicit transaction (autocommit suspended inside)."""
        return Transaction(self.pool)


class Transaction:
    def __init__(self, pool: PooledDB):
        self.pool = pool
        self.conn = None

    def __enter__(self):
        self.conn = self.pool.connection()
        self.conn.begin()
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            self.conn.close()
        return False


class Store:
    """Legacy converter store (jobs / items / match_cache) — port of node's Store class."""

    def __init__(self, db: Database):
        self.db = db

    def init(self):
        for stmt in SCHEMA_STATEMENTS:
            self.db.execute(stmt)

    def create_job(self, mode: str, source: str | None) -> str:
        job_id = uuid.uuid4().hex[:12]
        ts = now()
        self.db.execute(
            "INSERT INTO jobs (id, mode, source, created_at, updated_at) VALUES (%(id)s,%(mode)s,%(source)s,%(c)s,%(u)s)",
            {"id": job_id, "mode": mode, "source": source, "c": ts, "u": ts},
        )
        return job_id

    def set_job(self, job_id: str, fields: dict):
        assignments = ", ".join(f"{col} = %({col})s" for col in fields)
        params = {**fields, "updated_at": now(), "id": job_id}
        self.db.execute(f"UPDATE jobs SET {assignments}, updated_at = %(updated_at)s WHERE id = %(id)s", params)

    def add_total(self, job_id: str, delta: int):
        self.db.execute(
            "UPDATE jobs SET total = total + %(delta)s, updated_at = %(u)s WHERE id = %(id)s",
            {"delta": delta, "u": now(), "id": job_id},
        )

    def inc_processed(self, job_id: str):
        self.db.execute(
            "UPDATE jobs SET processed = processed + 1, updated_at = %(u)s WHERE id = %(id)s",
            {"u": now(), "id": job_id},
        )

    def add_items(self, rows: list[dict]):
        if not rows:
            return
        conn = self.db.pool.connection()
        try:
            with conn.cursor() as cur:
                sql = (
                    "INSERT INTO items (job_id, collection_idx, position, src_title, src_artist, src_duration,"
                    " status, score, yt_video_id, yt_title, yt_artist, yt_duration, collection_title)"
                    " VALUES (%(job_id)s,%(collection_idx)s,%(position)s,%(src_title)s,%(src_artist)s,%(src_duration)s,"
                    " %(status)s,%(score)s,%(yt_video_id)s,%(yt_title)s,%(yt_artist)s,%(yt_duration)s,%(collection_title)s)"
                )
                cur.executemany(sql, rows)
        finally:
            conn.close()

    def get_job(self, job_id: str) -> dict | None:
        return self.db.fetchone("SELECT * FROM jobs WHERE id = %(id)s", {"id": job_id})

    def list_jobs(self, limit: int = 50) -> list[dict]:
        return self.db.fetchall(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT %(limit)s", {"limit": limit}
        )

    def job_items(self, job_id: str) -> list[dict]:
        return self.db.fetchall(
            "SELECT * FROM items WHERE job_id = %(id)s ORDER BY collection_idx, position", {"id": job_id}
        )

    def cache_get(self, key: str) -> dict | None:
        return self.db.fetchone("SELECT * FROM match_cache WHERE `key` = %(key)s", {"key": key})

    def cache_put(self, key, video_id, yt_title, yt_artist, yt_duration, score):
        self.db.execute(
            """INSERT INTO match_cache (`key`, video_id, yt_title, yt_artist, yt_duration, score, created_at)
               VALUES (%(key)s,%(video_id)s,%(yt_title)s,%(yt_artist)s,%(yt_duration)s,%(score)s,%(created_at)s)
               ON DUPLICATE KEY UPDATE
                 video_id = VALUES(video_id), yt_title = VALUES(yt_title), yt_artist = VALUES(yt_artist),
                 yt_duration = VALUES(yt_duration), score = VALUES(score), created_at = VALUES(created_at)""",
            {"key": key, "video_id": video_id, "yt_title": yt_title, "yt_artist": yt_artist,
             "yt_duration": yt_duration, "score": score, "created_at": now()},
        )


def open_store() -> Store:
    store = Store(Database())
    store.init()
    return store
