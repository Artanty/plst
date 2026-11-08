# back/ — plst backend (python)

The python port of `back-node-js/` (which stays as the frozen behavioral reference — its 121-test
suite is the spec this port was verified against). Flask + PyMySQL + rapidfuzz + ytmusicapi.
Read the repo `AGENTS.md` first (logging rules, DECISIONS workflow).

## Commands

```bash
venv/bin/python app.py              # dev server (HOST/PORT from .env, default 0.0.0.0:3218)
venv/bin/pytest test -q             # the whole suite (local MySQL must be up: brew services start mysql)
venv/bin/pytest test -q -- -k scan  # subset
venv/bin/python cli_db.py           # the DB diagnosis ladder (TCP → login → grants → songs)
venv/bin/python cli_match.py <url>  # match dry-run (no DB writes)
venv/bin/python scripts/get_yandex_token.py
venv/bin/python scripts/logs.py --last 200 [--errors] [--ext] [--no-follow]
python3 scripts/sync_features.py    # re-vendor lib/ from ../feat (edit feat, sync here)
```

## Layout

```
app.py            Flask factory + boot: CORS, text/plain errors, poll-suppressing request log,
                  healthz / get-updates / features, converter routes (/ /migrate /jobs /job/:id),
                  library blueprint, periodic + shutdown skip-counter reports (flush before exit!)
config.py         settings from .env — same keys as back-node-js (YANDEX_TOKEN, DB_*, proxies,
                  SEARCH_CONCURRENCY, MATCH_ACCEPT/UNCERTAIN, DURATION_TOLERANCE, YTM_TIMEOUT, HOST, PORT)
db.py             PooledDB pool (ping=1) + legacy Store (jobs/items/match_cache)
matcher.py        normalize/transliterate/feature/score (rapidfuzz WRatio; 0.6/0.4, ×0.5/×0.3, 0.75/0.55)
model.py          matchUsable / cacheKey / SCORE_VERSION
paste_json.py     pasted-track JSON parsing (error strings byte-identical to node)
url_parser.py     yandex playlist/album/liked URL parsing
pipeline.py       converter job runner (background thread; injectable deps for tests)
library/          schema.py (16 tables, DDL parity) · migrations.py · keys.py (sha1 dedup keys on
                  the matcher's normalize) · store.py (scan-import transaction w/ deadlock fixes) ·
                  routes.py (the whole /api/library surface; exact error strings) · match.py ·
                  yandex.py · youtube.py · genre.py
ytmusic/          ytmusicapi wrapper: candidates in the node shape, retry/backoff, YTM_PROXY, timeout
yandex/           hand-rolled client (requests): anonymous search, device-id headers, WAF-403 fallback
lib/              VENDORED from ../feat (logging: logger.py + ext_log.py; db_diag.py) — edit in
                  feat, re-run sync_features.py; never edit vendored copies
templates/        Jinja2 mirrors of the node EJS admin pages
test/             pytest suite (116): throwaway schema per session (test/conftest.py), faked
                  YTM/Yandex deps; admin HTTP surface, store scenarios, unit ports
```

## Environment

`.env` (see `.env.example`) — same keys as the node build. FEAT_BACK_URL overrides the feat host
in the features config. TAG_VERSION/COMMIT_MESSAGE/PROJECT_ID/NAMESPACE/SLAVE_REPO flow into
`/api/get-updates` (deploy-injected).

## Parity notes

- Log files (app.log/error.log/ext.log, JSON-lines) are byte-compatible with the node build —
  either backend can read the other's files.
- Route surface, status codes, and error bodies (text/plain) match back-node-js exactly; the
  121-test node suite was the acceptance spec (see DECISIONS.md 2026-11-08 (3)).
- rapidfuzz WRatio is the C++ port of fuzzball's algorithm — the matcher test scores hold 1:1.
- The scoring/cache key includes SCORE_VERSION — bump it if normalize/scoring ever changes.
