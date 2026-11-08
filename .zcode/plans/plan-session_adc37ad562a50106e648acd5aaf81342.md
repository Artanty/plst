Convert plst@back to Python (Flask), full behavioral parity, node version preserved.

## Stage A — repo move (node preserved, nothing breaks)
- `git mv back back-node-js` (keeps history; package.json + 121-test vitest suite + views travel with it).
- New `back/` created fresh: `pyproject.toml` (version 0.0.1 — githooklib ≥2.2.0 reads python natively; back-node-js keeps npm versioning; TAG_VERSION composite keeps working), `requirements.txt`, `.env` + `.env.example` (same keys as node's: YANDEX_TOKEN, DB_*, proxies, tuning, HOST/PORT=3218), `venv/` (gitignored).
- Verify A: back-node-js suite still 121/121; `npm run dev` equivalent unaffected; githooklib dry check.

## Stage B — SDD: python implementations of the shared features in feat
- `feat/back/features/logging/v1/py/logging.py` + `ext_log.py`, `db-diag/v1/py/db_diag.py` — ports satisfying the SAME spec/md contracts (JSON-lines file format byte-compatible so node-written logs stay readable).
- Contract tests in feat: `back/test/test_logging_py.py`, `test_db_diag_py.py` (pytest in feat's venv) — the same cases as the .mjs suite.
- plst sync: `back/scripts/sync_features.py` (python sibling of sync-features.mjs) → vendors into `back/lib/`.
- Verify B: feat pytest green; plst suite untouched.

## Stage C — new back/ skeleton (Flask)
- `app.py` (app factory + CORS reflect-any-origin + text/plain error handler), `config.py` (dotenv settings, same names/defaults as node's settings), `db.py` (PyMySQL + DBUtils PooledDB pool; per-connection error logging like buildPool), vendored `lib/`, `logging_setup`.
- Routes: `/healthz`, `/api/get-updates`, `/api/features` (FEAT_BACK_URL env), 404 text handler.
- pytest smoke: healthz/features/get-updates shapes.
- Verify C: `python app.py` boots on 3218, vite dev talks to it.

## Stage D — library core
- `library/schema.py` (16 tables, DDL byte-parity), `migrations.py` (match_status column + user rename, information_schema-guarded), `store.py` (scan import transaction: artists→albums→songs→artist_songs sorted by dedup_key, batched 200, deadlock retry ×3 — the whole behavioral inventory).
- `library/routes.py` as a Flask blueprint with `x-user-id` before-hook (exact 400/404/403/404-not-403 semantics + error strings).
- Endpoints: users, me, songs (+filters/pagination clamps), song yandex, playlists CRUD/items/share/collaborators, notifications (+read), imports (pending/:id/to-playlist), scan, ext-logs, logs.
- Tests D: port `library.test.ts`, `library-users/migrations/ext-logs/library-logs.test.ts` 1:1.

## Stage E — matching & externals
- `matcher.py` (normalize: NFKC/brackets/noise/translit; sorted-word feature; score = 0.6*WRatio(title)+0.4*WRatio(artist) via **rapidfuzz** — same WRatio algorithm fuzzball ports; modifiers ×0.5 qualifier / ×0.3 duration; thresholds 0.75/0.55; query variants with early-stop), `ytmusic/search.py` (ytmusicapi + YTM_PROXY + YTM_TIMEOUT + 3× backoff), `yandex/client.py` (requests.Session, YANDEX_PROXY, anonymous search, WAF fallback), `library/yandex.py` (findTrackUrl 4/2 scoring), `export/youtube` (matched/uncertain/unmatched/searchFailed + text format), notifications payloads.
- Tests E: `matcher.test.ts` scores ported verbatim (this is where fuzzball↔rapidfuzz parity gets proven; any boundary drift gets an explicit documented tolerance), `library-youtube/yandex.test.ts` with faked deps.

## Stage F — pipeline, admin pages, CLIs
- `pipeline.py` (jobs/items/match_cache + background thread runner, SEARCH_CONCURRENCY semaphore), `paste_json.py`, `url_parser.py`, `templates/` (index/jobs/job in Jinja2 mirroring the EJS pages), `cli_db.py` (`db:check` ladder), `cli_match.py`, `scripts/get_yandex_token.py`, `scripts/logs.py` (logs tail), `scripts/sync_features.py`.
- Tests F: `db/pipeline/pasteJson/url.test.ts` ports + admin-page HTTP tests (form-encoded POST /migrate, 303 redirect, ?format=json/links).
- Verify F: full pytest run.

## Stage G — parity gate + cutover docs
- `pytest` green (target ≥ the 121 scenarios), back-node-js suite still 121/121, one boot of each against the same DB schema; vite dev against python back end-to-end (badge, library page).
- Docs: back/AGENTS.md (python), back-node-js/AGENTS.md note (frozen reference), DECISIONS results, know/entries update (back-py pattern), web BACK_URL untouched (same port 3218).

## Key parity invariants (pinned throughout)
Same .env keys; same routes/status codes/error strings (text/plain); same JSON shapes (epoch-float timestamps, bool coercions); same DB DDL + migrations; same log file formats; same FEAT_BACK_URL/TAG_VERSION envs; PORT default 3218.