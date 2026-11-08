"""Pytest harness — the port of back-node-js/test/mysql.ts.

One throwaway MySQL schema per session on the local dev MySQL (127.0.0.1:3306, root, no
password — `brew services start mysql`), dropped afterwards. The app under test is the REAL
Flask app (test_client) pointed at that schema, with the YouTube/Yandex dependencies faked so
tests never touch the network.
"""
import os
import sys
import time as _time
from pathlib import Path

import pymysql
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pymysql.cursors  # noqa: E402

from db import Database, Store  # noqa: E402
from library.schema import init_library  # noqa: E402
from library.migrations import migrate_library_songs, migrate_library_users  # noqa: E402
from library.store import LibraryStore, SEED_USERS  # noqa: E402


def _connect_dbless():
    return pymysql.connect(host="127.0.0.1", port=3306, user="root", password="",
                           autocommit=True, cursorclass=pymysql.cursors.DictCursor)


@pytest.fixture(scope="session")
def test_db_name():
    name = f"plst_py_test_{int(_time.time() * 1000)}_{os.getpid()}"
    conn = _connect_dbless()
    with conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE {name}")
    conn.close()
    yield name
    conn = _connect_dbless()
    with conn.cursor() as cur:
        cur.execute(f"DROP DATABASE IF EXISTS {name}")
    conn.close()


@pytest.fixture(scope="session")
def db(test_db_name):
    """The Database (pool) against the throwaway schema."""
    conn = pymysql.connect(host="127.0.0.1", port=3306, user="root", password="",
                           database=test_db_name, autocommit=True,
                           cursorclass=pymysql.cursors.DictCursor)
    yield Database(pool=_pool_from(conn))
    try:
        conn.close()
    except pymysql.err.Error:
        pass  # store paths using pool.connection() may have closed the shared connection already


def _pool_from(conn):
    """A minimal pool-like object handing out the single live connection (test-scoped)."""
    class _SinglePool:
        def connection(self):
            conn.ping(1)
            return conn

    return _SinglePool()


@pytest.fixture(scope="session")
def library(test_db_name, db):
    """LibraryStore over the throwaway schema, schema+migrations+seeds applied once."""
    init_library(db)
    migrate_library_songs(db)
    migrate_library_users(db)
    lib = LibraryStore(db)
    lib.seed_users()
    return lib


@pytest.fixture(scope="session")
def converter_store(db):
    return Store(db)


@pytest.fixture()
def match_deps():
    """Fake YouTube search: default 'no candidates'; tests override via `.results`."""

    class FakeSearch:
        def __init__(self):
            self.results = []

        def __call__(self, query):
            return self.results

    return {"searchSongs": FakeSearch()}


@pytest.fixture()
def yandex_deps():
    """Fake Yandex lookup: default None (no match); tests override via `.ref` / `.error`."""

    class FakeYandex:
        def __init__(self):
            self.ref = None
            self.error = None

        async def search_track(self, query):
            if self.error:
                raise self.error
            return self._result

        _result = None

        def __call__(self, *args, **kwargs):
            # node's YandexDeps shape: {searchTrack} — the library/yandex.py port consumes it.
            if self.error:
                raise self.error
            return self._result

    return {"searchTrack": FakeYandex()}


@pytest.fixture()
def client(library, match_deps, yandex_deps):
    """The real Flask app (test client) over the throwaway schema with faked externals."""
    from app import create_app

    app = create_app(store=None, library=library, match_deps=match_deps, yandex_deps=yandex_deps)
    app.config["TESTING"] = True
    return app.test_client()


def auth(user_id):
    return {"x-user-id": str(user_id)}
