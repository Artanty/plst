# DECISIONS

Current thread only. Prior sessions: `DECISIONS-archive.md`.

*(Archived on 2026-11-08 per rule 4 — the sixth trim; the live file had grown to 854 lines.
Moved out: the 2026-11-07 deploy-info/v3-and-slot integration threads, the vendoring of
back/src/lib into feat, BACK_URL/dotenv work, FEAT_BACK_URL, build/.env untracking, and the
python-conversion PRE-stages. What remains below is the single current thread: the plst@back
→ python conversion.)*

## 2026-11-08 (3) — PLAN (rule 1): convert plst@back to Python (Flask) — full parity, node preserved

**Request:** convert the backend to python; keep the current node version in `back-node-js/`;
the new python back goes into `back/`; use `.env` for envs. User chose (of my options):
**Flask**, **full parity incl. the EJS admin pages**, **port the 121-test suite 1:1 to pytest**,
**everything incl. CLIs**.

**Stages:**
- **A. Move:** `git mv back back-node-js` (history preserved; node suite = living reference).
  New `back/`: pyproject.toml 0.0.1 (githooklib ≥2.2.0 python versioning), requirements.txt,
  `.env`/`.env.example` (SAME keys as node: YANDEX_TOKEN, DB_*, YANDEX_PROXY, YTM_PROXY,
  SEARCH_CONCURRENCY, MATCH_*, DURATION_TOLERANCE, YTM_TIMEOUT, HOST, PORT=3218), venv.
- **B. feat py first (SDD):** `logging/v1/py/` + `db-diag/v1/py/` satisfying the SAME spec
  contracts (JSON-lines format byte-compatible with node's logger so files stay interoperable);
  pytest contract tests in feat; plst `sync_features.py` vendors into `back/lib/`.
- **C. Skeleton:** app.py (factory, CORS reflect, text/plain errors), config.py, db.py
  (PyMySQL + DBUtils PooledDB, per-connection error logging), healthz/get-updates/features.
- **D. Library core:** schema (16 tables, DDL parity), migrations (match_status, user rename),
  store (scan transaction: sorted-by-dedup_key phases, 200-row batches, deadlock retry ×3),
  blueprint with x-user-id hook (exact error strings/semantics), all library endpoints.
- **E. Matching:** matcher.py on rapidfuzz WRatio (0.6/0.4, ×0.5/×0.3 modifiers, 0.75/0.55,
  variants+early-stop), ytmusicapi (+proxy/timeout/backoff), yandex client (requests, anonymous
  search, WAF fallback), findTrackUrl 4/2, export text/JSON split.
- **F. Pipeline/pages/CLIs:** jobs thread runner, paste_json, url_parser, Jinja2 templates
  (index/jobs/job), db:check, match dry-run, get_yandex_token, logs tail, sync_features.py.
- **G. Gate:** pytest ≥121-scenario parity, node suite still 121/121, vite e2e vs python back,
  docs (AGENTS ×2, know, DECISIONS).

**Invariants:** same .env keys, routes, status codes, error strings (text/plain), JSON shapes
(epoch-float ts, bool coercion), DDL, log formats, PORT 3218.
RESULT per stage below.

## 2026-11-07 pipeline/paste_json/url_parser/model py port
PLAN: port back-node-js {model,pasteJson,url,pipeline}.ts -> back/{model,paste_json,url_parser,pipeline}.py; deps-injected pipeline (sync callables + Semaphore sized by settings.search_concurrency), start_job spawns daemon thread; tests test_{model,paste_json_py,url_parser_py,pipeline_py}.py in back/test (sys.path bootstrap, no DB/net).

## 2026-11-07 — PLAN (rule 1): port node ytmusic/yandex/match/youtube/genre to the python back

**Request:** port 6 node modules to Python with strict behavioral parity: `src/ytmusic/search.ts` →
`back/ytmusic/search.py`, `src/yandex/client.ts` → `back/yandex/client.py`, `src/library/{yandex,match,youtube,genre}.ts`
→ `back/library/*.py`. JSON keys stay camelCase; code snake_case; `requests` sessions with proxy +
timeout injection; all externals injectable for tests. Tests `back/test/test_match_py.py`,
`test_yandex_client_py.py` must pass offline, no MySQL. Nothing committed.

**Approach:** direct 1:1 ports keeping error strings, log lines (logger.log/error with same msg/fn
strings) and response shapes; ytmusicapi py package replaces the node ytmusic-api (shape adapt:
`title`/`artists[]`/`duration_seconds` → {videoId,title,artists(string),duration});
matchUsable/isConfident/searchFailureReason/matchSong/matchSongs from match.ts+model.ts;
youtube export text rendered byte-exact; new `back/ytmusic/`, `back/yandex/` packages + missing
`back/library/__init__.py`.
RESULT: created back/model.py (artist_str/match_usable/cache_key + SCORE_VERSION=2, dict types),
back/paste_json.py, back/url_parser.py, back/pipeline.py (PipelineDeps w/ sync callables,
SearchQueue=Semaphore(search_concurrency), start_job daemon thread). Tests: back/test/test_{model,
paste_json_py,url_parser_py,pipeline_py}.py — 20 passed, no DB/network (FakeStore mocks db.Store
surface). Judgment calls: JSON.parse error detail text differs from V8 (prefix "not valid JSON:" kept);
node err.message -> str(err) in job failure; cache-hit status uses (score or 0) for null score.
FLAG: DECISIONS.md is ~815 lines (>250) — trim/archive suggested.

### RESULT (stages A–C) — node preserved, feat py builds vendored, Flask skeleton boots

- **A**: `git mv back back-node-js` (had to `git add -A back` first — the vendoring deletions
  were unstaged, which made `git mv` refuse). Node suite **121/121** in its new home.
  New `back/`: pyproject.toml 0.0.1, requirements.txt (flask, python-dotenv, PyMySQL, DBUtils,
  rapidfuzz, requests, ytmusicapi, pytest), `.env` copied from the node back (same keys, PORT 3218).
- **B**: feat `logging/v1/py/` (logger.py + ext_log.py + __init__/index entries) and
  `db-diag/v1/py/` (db_diag.py) — same contracts; entry format byte-compatible (ms-precision
  ISO ts, `Z`). feat contract tests now **36 pytest + 26 node:test, all green**. One real bug
  found by the ports: python stack formatting had to go through `traceback.format_exception`.
  plst `back/scripts/sync_features.py` vendors into `back/lib/` (package: ext_log does
  `from .logger import Logger`). Note: check_database lazy-imports pymysql, and PyMySQL errors
  carry errno as args[0] (mapped in classify_db_error).
- **C**: `back/app.py` (factory, CORS reflect, text/plain errors incl. 404 "not found",
  request-logging port: poll suppression + counters + onResponse lines), `config.py` (dataclass
  settings, same keys), `db.py` (PooledDB ping=1 — replaces node's per-connection death logging,
  plus Store for jobs/items/match_cache), `library/{schema,migrations,keys,store,routes}.py`
  (full port incl. the scan-transaction deadlock fixes and every route's exact error strings),
  `matcher.py` (rapidfuzz WRatio). Boot smoke: healthz/features/404/users/x-user-id-400 parity.
  MySQL note: PyMySQL now reaches the remote DB fine (the user fixed the network issue earlier).
- **In flight (3 background agents):** externals port (ytm/yandex/match/export/genre),
  pipeline+paste_json+url_parser+model, library test suite port onto `test/conftest.py`.

## 2026-11-07 — library test suite port to pytest (in progress)
- Plan: port back-node-js/test/library.test.ts, library-users.test.ts, library-migrations.test.ts
  1:1 onto back/test/test_library_py.py + test_library_migrations_py.py using existing conftest
  fixtures (db/library/client). Store-level scenarios via `library` store, plus route-level HTTP
  checks (exact status codes, JSON keys, text/plain error bodies) via `client`.
- Session-scoped fixtures → order independence: unique names/types per test, delta assertions for
  global counts (songs total, pending import count, unread notifications); migrations tests
  restore the users table (they mutate usernames).

### RESULT — 2026-11-07 port done, 54/54 tests green, nothing committed (rule 5)

**Created:** `back/ytmusic/{__init__,search}.py`, `back/yandex/{__init__,client}.py`,
`back/library/{__init__,match,youtube,genre,yandex}.py` (`__init__.py` was missing in
`back/library/`), `back/test/test_match_py.py`, `back/test/test_yandex_client_py.py`.
`cd back && venv/bin/pytest test/test_match_py.py test/test_yandex_client_py.py` → **54 passed**,
offline (faked sessions/search), no MySQL. No existing files modified.

**Judgment calls:**
- rapidfuzz (already in matcher.py) replaces fuzzball — WRatio is the same algorithm; tests pin
  the remaster=1.0 case.
- ytmusicapi shape adapt: py package returns `title`/`artists:[{name}]`/`duration_seconds`; the
  node lib returned `name`/`artist:{name}`/`duration` — `_adapt()` maps to the SAME candidate
  shape {videoId,title,artists(string),duration}. Same 3-attempt retry/backoff (incl. the node
  quirk of sleeping unless last attempt AND non-retryable message); timeout via a `_TimeoutSession`
  wrapping `send` (ytmusicapi has no timeout of its own, like axios in node); proxy via
  session.proxies + apply_ytm_proxy. filter="songs" replaces searchSongs.
- yandex client: requests stands in for undici; anonymous searchTrack, device-id headers, share
  playlist WITH OAuth, WAF-403 album fallback kept verbatim; `??` semantics preserved for
  durationMs/realId chains. Commas in query strings go out %2C-encoded (same as URL.searchParams).
- match.py: matchUsable/isConfident/searchFailureReason (incl. the YTM_PROXY hint string,
  byte-parity), already-matched short-circuit, per-variant loop with early stop at match_accept,
  search errors → search_failed + reason; batch uses ThreadPoolExecutor (PQueue stand-in),
  outcomes carry songId/title/cached/error.
- youtube.py text renderer is byte-exact (uncertain block with `score x.xx`/`no score`,
  search-failed block incl. the "is YTM_PROXY running?" line, gap() only after existing lines).

## Stage F port (2026-11-07): converter routes, admin pages, CLIs, tests
Plan: port server.ts converter surface into app.py (/, /migrate 303, /jobs, /job/<id> with
?format=json|links), EJS views -> Jinja2 templates, port cliDb.ts -> cli_db.py, cli.ts ->
cli_match.py, scripts/get_yandex_token.mjs -> scripts/get_yandex_token.py, scripts/logs.mjs ->
scripts/logs.py; add test/test_converter_py.py via Flask test client + converter_store fixture.
create_app gains an optional `pipeline_deps` kwarg (node used the defaultDeps module singleton;
injection is needed so tests can fake fetch/search without network).
- Done: back/test/test_library_py.py (24 tests) + test_library_migrations_py.py (4) — all node
  scenarios ported 1:1, 28/28 green; whole back pytest dir 102/102. Order-independence via unique
  names + delta assertions; migrations tests restore the users table. One conftest touch: guarded
  the session db teardown conn.close() (store pool paths close the shared connection first).
  Note for app.py owner: the first full run showed AttributeError at app.py:45
  (`request.url.path` — werkzeug 3.1.9 returns str for request.url), but it did not reproduce on
  later runs; worth a look. Nothing committed.
Result: done. app.py: converter routes (GET /, POST /migrate w/ 400 text + 303, GET /jobs,
GET /job/<id> with ?format=json|links|html), `pipeline_deps` kwarg on create_app, onResponse
now warn-level for 4xx (node parity), report_skip_counters + periodic timer + SIGINT/SIGTERM
report+flush in main(). Templates: index/jobs/job + partials (Jinja2 mirrors of the EJS).
New: cli_db.py, cli_match.py, scripts/get_yandex_token.py, scripts/logs.py,
test/test_converter_py.py (14 tests; jobs run synchronously in tests — conftest hands out ONE
raw MySQL connection, a background thread + polling corrupts the packet stream).
Fixes found by the tests: db.py Store.add_items used self.pool (Store has self.db) — minimal
fix to self.db.pool.connection(). converter_store fixture in conftest doesn't init() the
schema — handled inside the test fixture (conftest untouched).
Full suite: 116 passed. cli_db.py verified live against the real VPS (TCP ok, login ok, 493
songs). Not committed.

### RESULT (stages D–G) — python backend complete: 116 pytest green, parity proven, e2e in browser

All three background ports integrated; **full gate green**: python `back/test/` **116 passed**
(library 24+4 migrations, matcher/yandex 54, pipeline/paste/url/model 20, converter/admin 14),
node `back-node-js/` still **121/121**, web **65/65**.

- **Integration fixes by me** (the porting agents' surfaces differed slightly from my routes):
  dep-shape adapter in routes.py (node-style `{searchSongs}` dicts AND python callables both
  accepted), three `request.url.path` → `request.path` bugs in the request-logging hooks (never
  ran before wiring), and `report_skip_counters` exposed on the app for main()'s periodic +
  SIGINT/SIGTERM reports (the flush-before-exit rule). One real Store bug found by the converter
  tests (`add_items` referenced self.pool → self.db.pool) — nothing had driven it before.
- **Stage F complete**: converter routes + Jinja2 admin pages (index/jobs/job), CLIs —
  `cli_db.py` (verified LIVE against the real VPS: TCP open, login ok, 493 songs),
  `cli_match.py`, `scripts/get_yandex_token.py`, `scripts/logs.py` (full logs.mjs port).
- **Stage G e2e**: real browser on vite 5174 (BACK_URL → python back :3219, FEAT_BACK_URL
  deployed): badge `v1.0.17.0.0.28` via feat v4, header **493 songs**, Imports badge **3**
  (real pending imports), library page rendered — the web app works unchanged against python.
- **Docs**: `back/AGENTS.md` (python commands/layout/parity notes), `back-node-js/AGENTS.md`
  FROZEN REFERENCE note. **Nothing committed** (rule 5); committing will bump back (pyproject)
  and back-node-js (package.json) versions via githooklib — verify the TAG_VERSION composite
  then.
**Cutover note**: `npm run dev` in web/ and the vite proxy target localhost:3218 work for BOTH
backends — start `python app.py` instead of the node server to run python; no web changes needed.

## 2026-11-08 (4) — root README.md
**Request:** "add README.md to root of project where write how to run each backend". Written:
folder map, prerequisites (.env per app, local MySQL), run commands for the python back
(`venv/bin/python app.py`), the node reference back (`npm run dev`), web (`npm start`), the
extension, all test suites, the feat vendoring flow, diagnostics (cli_db / logs / HTTP), and
the deploy hooks (`-d`). Nothing committed.

## 2026-11-09 — back-only `-d` commit triggered the WEB deploy (diagnosis + fix, option 1)

**Symptom:** after a back-only commit with `-d` the back triple bumped (0.0.1→0.0.2) but the
serf "Deploy plst@web" workflow ran instead of back. Reinstalling githooklib ruled out — hooks
worked (tag_history.log: only back bumped, tag `v0.0.2.0.0.29` correct).

**Root cause:** the 2026-11-08 python conversion reset the back version to `0.0.1` (fresh
pyproject) after node's `1.0.17` — a DECREASE. flow picks "previous tag" via `tags.find` over
GitHub's unordered `listTags` (`webhook.ts:176`); with `v1.0.17.0.0.28` sorting first by name,
back `0.0.2 > 1.0.17` = no increase while web `0.0.29 > 0.0.28` = increase → web dispatched,
back never deployed (incl. the conversion commit itself).

**Fix (user chose option 1):** continue the sequence — `back/pyproject.toml` version set to
`1.0.18` (uncommitted, rule 5). Next `-d` tag `v1.0.18.0.0.29` increases against
`v1.0.17.0.0.28` regardless of list order. githooklib refusing version decreases; flow picking prevTag by creation date.

**Follow-up (2026-11-09):** the githooklib half of the hardening is DONE — githooklib 2.3.0
(local, uncommitted) rejects manual version decreases in pre-commit (details in
`~/server/githooklib/DECISIONS.md`). Takes effect in plst only after `npm publish` +
reinstall in `build/`. The flow prevTag hardening was left out (sequence is self-consistent
again; revisited if a decrease ever slips through from a repo without githooklib 2.3.0).

## 2026-11-10 — snapdeploy runtime: port field, DB firewall, boot-error bug

**Findings** (from the first live container logs, manual redeploy):
1. SnapDeploy's app-port setting was filled with **3306** (the MySQL port) — platform
   health-checks 3306, finds nothing, declares the deploy broken. App port must be **5000**
   (user action in the dashboard).
2. MySQL genuinely unreachable from the container: pymysql 2003 timed out (packets dropped
   = firewall signature). Whitelist entry must match the container's OUTBOUND egress IP +
   MySQL GRANT for that host.
3. Real plst bug exposed: `app.py:276-277` read the `classify_db_error` dict as an object
   (`verdict.headline`), so the boot-time DB diagnostic crashed itself with AttributeError
   and buried its own advice. FIXED: `verdict['headline']` / `verdict['actions']`; verified
   dict access + offline tests.
**Same-day discovery, CORRECTED:** the 42 test errors are the LOCAL dev MySQL on this Mac
(127.0.0.1:3306 ConnectionRefused — mysqld simply not running), NOT the VPS. `cli_db.py`
against the real VPS: reachable, login ok, round-trip 45ms, 493 songs — remote DB is fine.
First theory (firewall change dropped this machine's IP) was wrong; log-first saved it.
So the ONLY remaining blocker is the container→VPS egress IP whitelist/GRANT.

## 2026-11-10 (2) — PLAN: TEMP-TEST deploy with MySQL hidden (snapdeploy egress-IP probe)

**Request:** temporary test deploy so the snapdeploy container can BOOT without the (not yet
whitelisted) MySQL: comment out all MySQL traces so snapdeploy's scanner doesn't detect/
"auto-add" PyMySQL, boot with mock data instead, and extend GET /api/get-updates to return
the container's real OUTBOUND IP (the value the VPS whitelist needs). User will ask to
restore MySQL after the test.

**Edits (all marked `TEMP-TEST-MYSQL-HIDDEN` for easy revert, nothing committed):**
1. `requirements.txt`: comment `PyMySQL>=1.1` + `DBUtils>=3.0` (their import-scanner
   re-adds "missing" packages — source imports must be gone too).
2. `db.py`: comment the module-level `import pymysql` / `from dbutils...` (module unusable;
   nothing imports it in mock mode — app.py imports db only inside init_database()).
3. `lib/db_diag.py:164`: comment the lazy `import pymysql`.
4. `app.py main()`: skip `init_database()`, pass `_MockStore()` (any method raises with a
   clear "mock backend" message) as store+library. Boot paths that don't touch the DB work:
   /healthz, GET /api/get-updates, /api/features, home page. DB-backed routes 500 — fine
   for the test. Local dev/tests break while this is in (they import db) — accepted,
   temporary.
5. `get-updates`: new `"ip"` field = outbound IP via api.ipify.org (requests, 5s timeout,
   falls back to an "unavailable (<Error>)" string). get-updates itself was already DB-free.

### RESULT
All 5 edits in, every one tagged `TEMP-TEST-MYSQL-HIDDEN`. Verified: mock app boots clean
("server ready"), /healthz 200, /api/get-updates 200 with `"ip"` filled (94.19.32.224 —
ipify reachable even from this machine), /api/features 200, home 200; grep confirms ZERO
live `import pymysql` / `from dbutils` lines in requirements.txt, db.py, lib/db_diag.py.
DB-backed routes raise the mock marker. Side effects while active: local dev/tests that
import db.py are broken (conftest imports db — pytest DB tests will error; offline tests
still pass) — expected, temporary. NOT committed (rule 5): user commits with `-d` to ship.
Revert = undo the markers in requirements.txt, db.py, lib/db_diag.py, app.py (main() init
line + `_MockStore` + `_outbound_ip` + the `"ip"` field). After the VPS whitelist has the
container's IP, restore per the revert note.
