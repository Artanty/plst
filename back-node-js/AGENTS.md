# AGENTS.md

Context for AI agents working in this repository. Read this before making changes.

## What this project is

**plst** — a web service that converts Yandex Music collections (playlist URL, album URL, liked tracks) — or track JSON pasted straight from the plst browser extension (`mode=json`) — into **YouTube Music links**. There is deliberately **no YouTube Music auth or writes**: output is a per-track match report and a plain list of `https://music.youtube.com/watch?v=<videoId>` links (links work anonymously).

Originally built in Python (FastAPI + yandex-music + ytmusicapi); **fully rewritten to Node.js/TypeScript** in-place — no Python code remains (except historical mention in git-less tree; don't resurrect it).

## Commands

```bash
npm test                 # vitest (121 tests: url, matcher, pasteJson, db, pipeline, library, logs, migrations, db-diag)
npm run lint             # tsc --noEmit
npm run build            # tsc -> dist/
npm start                # tsx src/server.ts (no build step; HOST/PORT env, default 0.0.0.0:8000)
npm run dev              # tsx src/server.ts
npm run db:check         # diagnose DB connectivity ladder: TCP -> login -> grants -> data; prints the fix SQL. Run THIS when the DB is unreachable.
npx tsx src/cli.ts match <yandex-url>   # CLI dry-run, prints link report
```

Not a git repo (no commits/PRs unless the user initializes one).

## File map

```
src/config.ts          env settings (dotenv): tokens, proxies, thresholds, MySQL connection
src/model.ts           TrackMeta / MatchResult / Candidate / Collection + helpers
src/url.ts             Yandex URL parser + Mode: playlist|liked|album|json (json parses no URL)
src/pasteJson.ts        parses extension/CLI track JSON -> {tracks, skipped}; used by cli.ts AND mode=json
src/matcher.ts         normalize/transliterate/queries/WRatio scoring (ported from Python original)
src/db.ts              mysql2 Store: jobs / items / match_cache (MySQL, async API)
src/pipeline.ts        job runner: runJob/runCollection/matchWithSearch/startJob; deps injection via PipelineDeps
src/yandex/client.ts   hand-rolled Yandex HTTP client (undici fetch) + fetchCollections + trackMeta
src/ytmusic/search.ts  ytmusic-api singleton wrapper: searchSongs -> Candidate[], retry + axios timeout setup
src/server.ts          Fastify app (buildApp exported for tests) + startup guard
src/cli.ts             match dry-run CLI
src/cliDb.ts           `npm run db:check` — the DB diagnosis ladder (see "When the database is unreachable")
src/lib/*              VENDORED from the feat project (../feat/back/features/*/v1/js-node/):
                       logger.js + ext-log.js (logging feature), dbDiag.js (db-diag). Specs live
                       in feat/back/spec/, contract tests in feat/back/test/. EDIT IN FEAT, then
                       `npm run features:sync` — never edit the vendored copies in place.
views/*.ejs            3 pages (index/job/jobs) + partials/head.ejs, partials/tail.ejs
scripts/get_yandex_token.mjs  one-time Yandex OAuth Device Flow token fetch (public app creds inside)
test/*.test.ts         vitest suites; DB tests run against local MySQL (brew), one throwaway schema each
```

## Data flow

```
POST /migrate {mode, source} -> validates via fromForm(), or via parseTrackJson() when mode=json
  (bad paste = 400, no job created) -> startJob() -> store.createJob + fire-and-forget runJob()
startJob stores a SHORT label for json jobs ("pasted JSON, N tracks"), never the raw blob:
  jobs.source is printed verbatim on the job page. runJob still gets the full text by argument.
runJob: fromForm() -> mode=json builds the Collection from parseTrackJson and SKIPS fetchCollections
  entirely (zero Yandex requests — the API is unreachable from the dev box anyway);
  otherwise fetchCollections() [Yandex] -> per collection:
  sequential per track: dedupe by title|artists|duration -> matchWithSearch
    (check match_cache -> for each query in buildQueries(): search via p-queue
     -> matchTrack score; stop early on 'matched'; cache only when videoId found.
     Stop-early-on-'matched' means a below-threshold track only ever sees ONE query's candidates,
     so a track the first query misses can never be recovered - that is why live runs can differ
     between passes even for the same JSON.)
  -> write items rows -> summary counts
UI polls GET /job/:id every 3s; ?format=json and ?format=links (text) exports.
```

Match status: `matched` (score ≥ MATCH_ACCEPT 0.75) / `uncertain` (≥ 0.55) / `not_found` / `skipped_dup`. Scoring: `0.6*title WRatio + 0.4*artist WRatio` on normalized strings, `×0.3` penalty when duration differs > max(5s, 10%). Queries include a Cyrillic→Latin transliteration variant.
**`x0.5` qualifier penalty** (matcher.ts QUALIFIER_RE): normalize() deletes all bracketed text, so "...Dancin' (Teenage Bad Girl Remix)" scored an identical 1.00 to the studio cut, and remixes are often seconds shorter so the duration check misses them too. Any candidate title carrying remix/live/acoustic/cover/instrumental/karaoke/demo/sped-up/slowed that the source lacks is halved. `remaster` is deliberately excluded - a remaster is the same recording.
**`SCORE_VERSION` in pipeline.ts cacheKey**: match_cache stores the verdict AND the score, so any scoring change must bump the version or already-cached tracks silently keep the old verdict forever (this bit us - a fix verified in a unit test still returned the bad cached 1.00 in a live re-run).

## Hard-won knowledge (don't rediscover)

### Yandex Music API (raw HTTP)
- Base: `https://api.music.yandex.ru`, responses are `{result}` or `{error:{name,message}}` — **HTTP status is often 200 with an error body**; client throws on `error`.
- **`User-Agent: Yandex-Music-API` is required** for anonymous requests (other UAs get `not-found` errors!). Token requests: `Authorization: OAuth <token>` (yes, `OAuth` prefix, not `AuthToken`).
- Endpoints used: `/users/{uid}/playlists/{kind}`, `/users/{uid}/playlists/list`, `/users/{uid}/likes/tracks`, `/users/{uid}/likes/albums?rich=true`, `/tracks?trackIds=a,b,c&with=pos` (batch ≤50), `/albums/{id}/with-tracks` (hyphen — `with/tracks` 404s).
- Anonymous: public playlists/albums work; likes and private playlists need a token (`ownerOtherwiseUserBindingError` / `playlistIdBindingError` otherwise). `uid="me"` works with token.
- Raw track JSON: `title`, `artists[].name`, `durationMs` (milliseconds), `albums[]`, `realId`. Likes `/likes/tracks` returns only `trackId`s → must batch-fetch `/tracks`.
- Device Flow (token script): `https://oauth.yandex.ru/device/code` + `/token`, public Android app client_id/secret are in `scripts/get_yandex_token.mjs` and `yandex-music` Python lib history.

### YouTube Music side
- `ytmusic-api@5.3.1` (npm, zS1L3NT/ts-npm-ytmusic-api) — **read-only** (search etc., NO playlist writes/OAuth). `initialize({HL, GL})` only; anonymous search.
- Internally uses **axios**: it honours `HTTP(S)_PROXY`/`http_proxy` env vars (set via `applyYtmProxy()`), and **has NO default timeout** → blocked YouTube hangs forever. Fix already in `ytmusic/search.ts`: `axios.defaults.timeout = settings.ytmTimeout` before constructing the client (its `axios.create()` inherits global defaults).
- `searchSongs()` returns `{videoId, name, artist:{name}, duration (seconds|null)}` — mapped to `Candidate{videoId,title,artists,duration}` in `search.ts`.
- `axios` is a DECLARED dependency on purpose: `ytmusic/search.ts` imports it only to set `axios.defaults.timeout` (ytmusic-api creates its client from a plain `axios.create()`, which inherits global defaults, and has no timeout of its own - blocked YouTube would hang forever). It used to resolve only as a ytmusic-api transitive, so a transitive bump could break search at runtime.
- **YouTube is only reachable THROUGH THE PROXY, not directly.** An earlier version of this line said the dev machine "cannot reach YouTube" flatly — that is wrong as of 2026-10-02 and was costing real work. Verified live: `YTM_PROXY` **is set in `.env`**, and with it a real search returns real candidates (20 for "The Police Roxanne"; `Roxanne` → `fZheUzgIFEk` at score **1.00**). Direct/unproxied connections still drop. So: **match and export features can be verified live on this box** — do not hide behind mocked deps, and do not assume matching is impossible here. Mocked deps are still the right tool for deterministic scoring tests. Expect long wall-clock times when the proxy is unset or YouTube is actually blocked (retries × timeouts) — that is correct behavior, not a bug.
- **An `uncertain` match is not a link.** Verified live: a Yandex "Roxanne" carrying a wrong duration matched to *"Message In A Bottle — The Police"* at 0.57, and an earlier version of the export pasted it as if it were Roxanne. `library/youtube.ts` therefore puts anything below `matchAccept` in a separate `uncertain` list, commented out of the text output, instead of dropping it or linking it. The same reasoning already applied to the popup's PERFECT threshold.

### Environment quirks (this dev box)
- Node v24 + npm 11 present; npm registry reachable. Python 3.10 exists but system python has **no ensurepip** (use `~/.local/bin/virtualenv` if python tooling ever needed).
- Server smoke-test pattern: `PORT=xxxx nohup node dist/server.js >log 2>&1 & echo $! >pid` then curl, `kill $(cat pid)`. Avoid `pkill -f <pattern>` where the pattern matches the command itself (it killed its own shell once).
- `plst.db*` SQLite files may linger from old dev runs (gitignored). The app now stores everything in **MySQL** (see `.env`: `DB_HOST`/`DB_PORT` (3306)/`DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD`); tables auto-create on startup via `openStore()`. Local MySQL (`brew services start mysql`, root/no password) is used by the test suite (`test/mysql.ts` creates a throwaway `plst_test_*` database).

## Conventions & gotchas
- ESM + TS NodeNext: **relative imports need `.js` extensions** (`./config.js`) in `src/`.
- `npm start` runs `tsx src/server.ts` — the render.yaml deploy is `npm install` + `npm run start` with **no build step**, so `dist/` is optional there. `tsx` is a runtime dependency by design (survives `NODE_ENV=production` installs).
- `src/server.ts` starts listening only when run directly (`node dist/server.js` / `tsx src/server.ts` / `PLST_RUN=1`); `buildApp(store)` is exported so tests could import it — tests currently don't need a server.
- Views resolved from `process.cwd()/views` — run server from repo root.
- Pipeline is testable by passing `{fetchCollections, searchSongs}` fakes as `PipelineDeps` — keep this pattern; no network in tests.
- Fastify v5: reply.view via `@fastify/view` with `engine: { ejs }` (object form); pass all template vars through `reply.view(name, data)` (no `global` option in v11).
- Jobs run in-process (`startJob` fire-and-forget); a restart abandons `running` jobs (match_cache makes re-runs cheap). No auth/rate limiting — designed for admin-run deployment.
- Tuning envs: `MATCH_ACCEPT`, `MATCH_UNCERTAIN`, `DURATION_TOLERANCE`, `SEARCH_CONCURRENCY`, `YTM_TIMEOUT` (ms!), `YTM_PROXY`, `YANDEX_PROXY`, `YANDEX_TOKEN`, `HOST`; DB via `DB_HOST`/`DB_PORT` (3306)/`DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD`. Note `YTM_TIMEOUT` is **milliseconds** (default 20000).

## Verifying changes
1. `npm test` (must stay green; 121 tests) and `npm run lint`.
2. Yandex-side changes: live-check against album `1193829` ("Colour", Andy Hunter, 12 tracks, anonymous) — CLI `match` will hang-ish on searches (no YouTube here); prefer a tiny tsx script importing `fetchCollections` with a fresh `YandexClient(null, null)`.
3. Server changes: build, start on a test port, curl `/healthz`, `/`, `/jobs`, POST `/migrate` (album 1193829) expecting `303`, poll `/job/<id>?format=json` expecting eventual `done` with 12 `not_found` items when YouTube is blocked.
4. Matcher changes: run test suite; scoring uses fuzzball `WRatio` (0–100, divided by 100) — rapidfuzz-equivalent but values differ slightly from the old Python implementation; thresholds 0.75/0.55 tuned for it.

## Never do
- Commit `.env` or tokens (gitignored; YANDEX_TOKEN is a secret).
- Add YTM write/auth unless the user explicitly asks — links-only was a deliberate decision.
- Trust that public playlist fetching needs auth (it doesn't, with the right UA) or that YouTube is reachable from the dev host (it isn't).

### When the database is unreachable (added 2026-10-20)

The remote MySQL (`185.114.247.197`, Timeweb VPS `vh328`) has failed twice in ways that LOOK
identical from the app (`connect ETIMEDOUT`) but have DIFFERENT fixes, so never guess from the
error alone — the layers were proven apart on 2026-10-13/20:

1. **Firewall/network layer** — the VPS firewall only lets certain public IPs through, and the
   grant is IP-pinned to `'cs99850_yaum'@'93.100.74.64'` (no `%` entry). Working from a NEW
   location drops TCP before MySQL speaks: `ETIMEDOUT`. Fix: open 3306 for the current public IP
   in the Timeweb panel, or use an SSH tunnel (`ssh -L 3306:localhost:3306`, then
   `DB_HOST=127.0.0.1` — the safer option that does not expose MySQL).
2. **MySQL layer** — TCP arrives, MySQL rejects the login: `Access denied for user 'x'@'<ip>'`.
   Either `DB_PASSWORD` in `.env` is wrong, or no grant matches the address. The error message
   itself names the address MySQL saw.

**Run `npm run db:check` (in `back/`)** — it walks the ladder in order (public IP → TCP probe →
login/`CURRENT_USER`/`SHOW GRANTS` → songs count), names the failing layer, and prints ready-to-run
fix SQL with the observed address filled in (the password is never printed — it stays a
`<same-password-as-DB_PASSWORD>` placeholder). It exits 1 on any failed layer.

The server also logs the classification itself: at boot (the DB init is wrapped — a dead DB logs
the classified headline + what to do to `logs/app.log`/`error.log` and FLUSHES before dying, per
the SIGTERM flush lesson) and mid-run (mysql2 pools do NOT emit `'error'` — the pool only evicts
the dead connection silently; `buildPool` attaches a per-`connection` error listener, which is the
only place a mid-run flap becomes visible). `PROTOCOL_CONNECTION_LOST` after idle time is normal
pool recycling (`wait_timeout`), not an outage — the log line says so.

### Library: YouTube matching and the link export (added 2026-10-02)

- `library/match.ts` wraps the EXISTING matcher (`matcher.ts`) for library songs. It deliberately does
  not reimplement scoring — a second implementation would drift and quietly disagree with the
  converter. `searchSongs` is injected (`MatchDeps`) so scoring tests stay deterministic.
- **Before this, nothing ever wrote `songs.yt_video_id`** — the converter wrote video ids into its own
  job tables, so a library song could never produce a YouTube link and any export would be empty.
- Endpoints: `POST /songs/:id/match`, `POST /playlists/:id/match` (capped at 50/request), and
  `GET /export/youtube?playlistId=|songIds=&format=text|json`.
- The export never silently drops songs: unmatched songs are listed by name as comments, and
  `uncertain` matches are commented out entirely (see the "uncertain is not a link" note above).
- "Create a playlist from the library" is `POST /playlists` with `songIds` — one transaction
  (`store.createPlaylistWithSongs`), because create-then-add over HTTP leaves an empty playlist behind
  whenever the second call fails.
- `web-angular/src/app/core/library-api.ts` owns the song selection signal, deliberately NOT the library page
  component: the songs resource is paged, so a page-held selection is rebuilt from the visible rows and
  page 1's ticks vanish when you press "next". Covered by `library-api.spec.ts`.

## FROZEN REFERENCE (2026-11-08)

This node backend is now the **behavioral reference** for the python port in `../back/` — it
stays runnable and its 121-test suite stays green, but new backend work happens in `../back/`
(python). Port report: `../DECISIONS.md` 2026-11-08 (3). To run the node version:
`npm run dev` (or `start`), `npm test` — everything still works as before.
