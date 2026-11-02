# DECISIONS

Current thread only. Prior sessions: `DECISIONS-archive.md`.

*(Archived on 2026-10-20 per rule 4 — the fifth trim; the live file had grown to 508 lines
against the ~250 threshold. Moved out: the whole 2026-10-13 batch (import deadlock fix + ext
tabs/scrape-intervals/sidebar-only; toolbar-click opens the side panel; web-vanilla removal +
build-playlist page + listen-on-Yandex; the scan self-heal 0.5.2; the scan pause/stop UI 0.5.3;
and the fourth archival entry itself). What remains below is the single current thread:
search_failed vs not_found, 2026-10-19/20.)*

## 2026-10-20 — PLAN (rule 1): DB-down visibility — actionable boot logging + `npm run db:check` diagnostic

**Request:** "add logging to run back dev server — I want to know what to do when it happens
again; prepare the needed functions to run (SQL I think)." "It" = the remote MySQL
(`185.114.247.197`, Timeweb VPS) becoming unreachable / refusing the user's location — proven
yesterday to be TWO layers: a firewall dropping TCP (ETIMEDOUT, before MySQL speaks) and an
IP-pinned grant `'cs99850_yaum'@'93.100.74.64'` (would answer Access denied from another IP).

**Approach:**
1. `back/src/lib/dbDiag.ts` (new, testable, no side effects at import): `classifyDbError(err)`
   → `{kind, headline, actions[]}` for ETIMEDOUT / ECONNREFUSED / ENOTFOUND / handshake-truncated
   / ER_ACCESS_DENIED_ERROR / ER_DBACCESS_DENIED_ERROR / fallback — each with the concrete next
   step ("firewall on the VPS", "MySQL not listening", "run db:check", …); `probeTcp(host, port)`
   (net.connect with timeout, classifies timeout vs refused vs ok + latency); `checkDatabase(cfg)`
   (mysql2 direct connection: login → CURRENT_USER()/@@hostname/VERSION() + SHOW GRANTS + song
   count; classifies the failure through the same classifier); `publicIp()` (ifconfig.me,
   tolerant of failure).
2. `back/src/cliDb.ts` (new, run via tsx like the existing `match` CLI): `npm run db:check` —
   prints the whole ladder: env target, this machine's public IP (what the DB sees), TCP probe,
   MySQL login probe, grants, song count — and per-failure next steps; on access-denied it prints
   ready-to-paste SQL (CREATE USER/GRANT for the CURRENT public IP, password as `<same-password>`
   placeholder — never prints the real one) plus the firewall-layer note. tsx-run in src/ so
   `npm run lint` typechecks it.
3. `back/src/db.ts buildPool`: `pool.on('error')` — mid-run idle-connection deaths logged with
   host:port + "run npm run db:check", so the flap that breaks a running server is visible.
4. `back/src/server.ts` boot: wrap initLibrary+migrations+seedUsers in try/catch — on failure
   log the CLASSIFIED headline + actions via logger, **await logger.flush()** (AGENTS.md: an
   unflushed pre-exit line never reaches the file), then rethrow.
5. `back/package.json`: `"db:check": "tsx src/cliDb.ts"`. `back/AGENTS.md`: document the command,
   fix the stale "28 tests" line, note the DB-down procedure. Tests: classifier cases +
   probeTcp against a closed local port + checkDatabase against the local mysql harness. RESULT below.

### RESULT — DB-down visibility: classified boot/run logging + `npm run db:check`

**Done, nothing committed (rule 5).** Suite: **121 tests / 15 files** green (14 new in
`test/db-diag.test.ts`), lint clean. Every claim below was proven live, not just unit-tested.

- **`back/src/lib/dbDiag.ts`** — `classifyDbError(err, host?)`: ETIMEDOUT→firewall/VPS advice
  (with the real `DB_HOST` interpolated into the `ping`/`nc` commands it hands out), ECONNREFUSED→
  "nothing is listening", ENOTFOUND→DNS, **PROTOCOL_CONNECTION_LOST**/ECONNRESET→reset,
  ER_ACCESS_DENIED_ERROR→dual-cause (wrong password OR no grant for the address MySQL reported),
  ER_DBACCESS_DENIED_ERROR, unknown fallback. `grantSqlForUser(user, clientHost?)` auto-fills the
  address MySQL itself printed in the Access-denied message; password stays a `<…>` placeholder —
  a test asserts no real/empty password can appear in the SQL. `probeTcp` (injected connect for
  the timeout case), `checkDatabase` (login → CURRENT_USER/@@hostname/VERSION + SHOW GRANTS + song
  count; short connectTimeout so a dead DB diagnoses in 8s, not 10s), `publicIp`.
- **`back/src/cliDb.ts` + `npm run db:check`** — the ladder, live-verified all three ways:
  happy path (493 songs, grants printed, exit 0); `DB_PORT=3307` → timeout verdict + `nc`/Timeweb
  advice, stops before login, exit 1; `DB_PASSWORD=wrong` → access-denied verdict + ready SQL with
  `'cs99850_yaum'@'93.100.74.64'` filled in, data step says "skipped" instead of a red-herring
  "no songs table", exit 1.
- **`back/src/server.ts`** — boot DB work moved into `initDatabase()` (openStore + initLibrary +
  both migrations + seedUsers — everything that opens a MySQL connection), catch classifies,
  logs headline + actions, **`await logger.flush()`**, rethrows. Non-DB work (buildApp, listen)
  stays outside so a Fastify bug can't be mislabeled "database unreachable". Live: dead target →
  terminal shows the ladder AND `logs/app.log` has the action lines AND `logs/error.log` has the
  classified ERROR with stack (the flush rule — an unflushed pre-exit line never reaches the file).
  Healthy boot re-smoked: `/healthz` ok, `/` 200, library routes answer.
- **`back/src/db.ts buildPool`** — discovered mid-work that **mysql2 pools do not emit `'error'`**
  (`base/pool.js` emits only acquire/connection/release/enqueue; `pool_connection.js` just evicts
  the dead connection). Listened per-connection via the forwarded `'connection'` event instead —
  and openStore's inclusion in initDatabase came from the same investigation (it was the first
  DB call and would have died unclassified, outside any try/catch). Live-proven with a TCP RST
  against a real pooled connection: the log line names the cause, and that experiment is exactly
  how `PROTOCOL_CONNECTION_LOST` ("Connection lost: The server closed the connection.") was found
  to be unclassified — now mapped to reset with advice separating routine `wait_timeout` recycling
  from a real outage.
- **`back/AGENTS.md`** — stale "28 tests" fixed in both places (→ 121), `db:check` documented in
  Commands + file map, new "When the database is unreachable" section (both layers, the tunnel
  option, what the logs now tell you).

**User: to use this, restart the backend once** (also applies the earlier `match_status`
migration). When it happens again: read the boot/run log lines, then `cd back && npm run db:check`.

## 2026-10-19 — PLAN (rule 1): match must say "search_failed" when YouTube was unreachable, not "not found"

**Bug report:** import worked (7 tracks), but matching the created playlist "did not find any of
tracks in YouTube Music".

**Cause (from `back/logs/error.log`, quoted):** `15:34:05 [libraryMatch] youtube search failed
for "Linkin Park Somewhere I Belong" — Error: connect ECONNREFUSED 127.0.0.1:8080`. `back/.env`
has `YTM_PROXY=http://127.0.0.1:8080`; that local proxy was not running, and it is genuinely
required (direct YouTube DNS does not resolve from this machine — curl exit 6). All 7 searches
died before leaving the machine. The true cause was logged, but `match.ts` swallowed it into
`status:'not_found'` — a confident wrong answer in the UI ("not in the catalog" vs "could not
ask"). **Immediate user fix (no code): start the proxy, press "match all" again** — failures
store nothing, so the retry is clean.

**Approach (user-approved scope: search_failed distinction, no health probe):**
1. `back/src/model.ts`: `MatchStatus` gains `'search_failed'`; `MatchResult` gains
   `reason?: string | null`. (`matchUsable` already rejects anything but matched/uncertain.)
2. `back/src/library/match.ts` (`matchSong` catch): return `{status:'search_failed', score:0,
   videoId:null, reason}` — reason names the underlying error and appends the proxy hint when
   `settings.ytmProxy` is set ("ECONNREFUSED via YTM_PROXY=… — is your proxy running?").
3. `back/src/library/routes.ts` + `youtube.ts`: aggregate `searchFailed` separately from
   `unmatched` — `POST /playlists/:id/match` (response+log), `GET /export/youtube`
   (report+log), `POST /songs/:id/match` passes `reason` through.
4. Web: `library-api.tsx` types (`search_failed`, `reason`, `searchFailed`); `LibraryPage.tsx`
   and `PlaylistDetailPage.tsx` show "⚠ YouTube Music unreachable: <reason>" instead of
   "no match"; match-all summary and export report name the failed count.
5. Tests: matcher.test.ts (throwing search dep → search_failed + reason; batch counts it);
   library/library-youtube tests (route returns searchFailed; reason passthrough). Back suite,
   web tsc+tests. RESULT below.

### RESULT — match says "search_failed" (with the cause) instead of lying "not found"

**Done, nothing committed (rule 5).** The whole chain now carries the distinction, so a dead
proxy can never again masquerade as a missing song.

- **`back/src/model.ts`**: `MatchStatus` gains `'search_failed'`; `MatchResult` gains
  `reason?: string | null`. (`matchUsable` already rejected it — no change needed.)
- **`back/src/library/match.ts`**: `matchSong`'s search-error catch returns
  `search_failed` + `searchFailureReason(err)` — the underlying cause (first line only; axios
  messages carry request configs after a newline) plus, when `YTM_PROXY` is set, "all requests go
  through YTM_PROXY=…; is that proxy running?". `matchSongs`' own catch (unexpected throw) does
  the same — an unanswered song must not read as a real answer.
- **`songs.match_status VARCHAR(16) NULL`** — new column (schema + `migrateLibrarySongs` in
  `migrations.ts`, guarded via information_schema because CREATE TABLE IF NOT EXISTS never alters
  a live table; idempotent — a second ALTER would throw ER_DUP_FIELDNAME and kill boot). Runs at
  boot in `server.ts`. `setSongMatch` stores the status; `matchableSongs` reads it back.
- **`back/src/library/youtube.ts`**: export splits the two failures — `searchFailed` (never
  searched; text block says "Fix the connection (is YTM_PROXY running?) and press match again")
  from `unmatched` (a real "asked, not in the catalog" answer). Both lists still name every song.
- **`back/src/library/routes.ts`**: `POST /playlists/:id/match` returns + logs `searchFailed`;
  song match passes `reason` through and logs it; export log counts `searchFailed`.
- **Web (React + Angular, both)**: `search_failed` in the status union, `reason`, `searchFailed`
  in the export DTO; per-song messages say "⚠ YouTube Music was unreachable — '<song>' was never
  searched. <reason>"; match-all says "⚠ … none of the N songs were searched. Start your proxy
  and press match again" when ALL failures are search_failed (the user's exact 0-of-7 case),
  otherwise "X of Y matched — Z could not be searched"; export head + body list the never-searched
  songs separately. Angular needed the same fix or it would have shown "✓ matched (0%)".

**Verify**: back **106 tests** + lint (the one `library-logs` timeout is environmental —
importing `server.js` blocks ~10s on the currently-DOWN remote DB `185.114.247.197` while that
test's limit is 5s; it passes with the DB up and touches nothing changed here); new
`library-migrations.test.ts` drops the column and proves the migration adds it and re-runs as a
no-op; web tsc + **68 tests** + build; Angular build + **25 tests**. **Live**: with the user's
proxy on 8080 started, `searchSongs("Linkin Park Somewhere I Belong")` returns 20 candidates,
top = `Somewhere I Belong — Linkin Park -> -YQ8IbVIwPM` — the exact search that failed
ECONNREFUSED on 10-19. **User: restart the backend once** (boot applies the column migration),
then "match all" again with the proxy up.

---

## 2026-10-27 — commit the accumulated working tree (user asked "commit changes")

**Plan**: group the heavily-modified tree into logical commits by thread, in dependency order
(backend before frontend); never commit the user's untracked `input/`; plain imperative subjects,
no `-d` (nothing should deploy/push).

**Result**: five commits, all local:
1. `b37df27` extension 0.5.1–0.5.3 (side panel on toolbar click + worker logging, scan
   self-heal reload+retry, pause/stop icons + disabled buttons + `syncButtons`); manifest
   0.4.0→0.5.3, new `background.js`, `test/panel.test.js`. **47/47 Playwright green**.
2. `1248b70` backend `search_failed` chain + listen-on-yandex (`library/yandex.ts`,
   anonymous `searchTrack` in `yandex/client.ts`, `match_status` migration).
3. `4a4cd5f` `search_failed` UI in React + Angular; `YandexRef`/`yandexListen` API surface.
4. `805f360` DB-outage diagnosis: `lib/dbDiag.ts` (two-layer classifier, `probeTcp`,
   `checkDatabase`, `grantSqlFor`), `npm run db:check` CLI, per-connection pool error logging,
   boot `initDatabase()` + classified catch + `await logger.flush()`; `back/AGENTS.md` docs.
5. `4a198a4` removed `web-vanilla/` (20 files, −2241 lines); build-playlist page moved into
   React (`BuildPlaylistPage.tsx`, `build-state.ts`, spec).

**Hook discovery (worth remembering)**: this repo has githooks (`core.hooksPath` →
`build/node_modules/githooklib/hooks`). The **pre-commit hook auto-bumps the patch version** in
`back/package.json`/`web/package.json` when staged files change in that folder, then `git add`s
the file — so version bumps (back 1.0.14→1.0.16, web patch bump) rode into commits 2/3/4
automatically. The **post-commit hook pushes and tags only when the commit message contains
`-d`** — which is exactly why the working agreement forbids the `-d` suffix: every commit here
stayed local. Verified the sweep behavior empirically in a scratch repo (hook-staged file enters
a pathspec-limited commit; leaves an `MM` index residue — cleared with `git add`).

**Verify**: back 121 tests + lint, web tsc + 68 tests, ext 47/47 — all green before committing
(no code changed during the commit session itself). `input/` left untracked on purpose.
**User: restart the backend once** so boot applies the `match_status` migration.

---

## 2026-11-01 — PLAN (rule 1): personal knowledge library at `~/server/know` (index + entries, no discovery layer)

**Request:** "in know folder i want to make smth like knowledge library… main .md document with
links to single cases. And folder with separate files, each is a knowledge entry. In future in
new project i want to say smth like 'read about deploy slave in know@'."

**Approach (user chose from the presented options):** location **`/Users/artyomantoshkin/server/know`**
(sibling of `plst`, outside any repo — same reach from every project), discovery **none** (pure
files, explicit path references; entries stay plain markdown, portable across agent tools — ZCode,
OpenCode, anything that can read a file). Skills (`SKILL.md` per entry) were considered and
rejected for now — reference notes aren't really skills; a `know@slug` convention line in
`~/.zcode/AGENTS.md` or a launcher skill can be layered on later without restructuring.

1. `know/README.md` — the main doc: what it is, exact usage phrasings (absolute paths), how to
   add an entry, and the **index**: one line per entry (`[slug](entries/slug.md) — one-liner`).
2. `know/entries/_template.md` — copy-me template; `When to use:` is the first line after the
   title so relevance is judgeable instantly; then Context / Steps·facts / Gotchas / Related.
   No frontmatter — filename IS the slug.
3. `know/entries/deploy-slave.md` — first entry, **skeleton only** (Goal / Prerequisites /
   Steps / Verification / Gotchas with `<fill in>` markers); no invented facts — the real
   content is the user's to write.
4. No git setup inside `know/`, no commits anywhere (rule 5). RESULT below.

### RESULT — library scaffolded

`/Users/artyomantoshkin/server/know/` created and verified via `ls -laR`: `README.md` (index +
usage phrasings + add-entry how-to), `entries/_template.md`, `entries/deploy-slave.md`
(skeleton). Nothing committed; `know/` has no git.

## 2026-11-01 — PLAN (rule 1): fill `know/entries/deploy-slave.md` from the real infrastructure

**Request:** user described the deploy pipeline (main-acc repos with web/+back/ folders;
githooklib bumps a 6-digit version and pushes on a "-d" commit suffix; flow GitHub App detects
changed folder and runs the serf action; serf asks safe-project-database for the slave repo +
envs + endpoint config; private slave repos on 'main' with secrets inline in .env; endpoints:
vercel/render/other or Timeweb VDS per server/note) and asked to **check it against the code**
in server/{githooklib,flow,serf,note}, structure it, ask questions, and produce the complete
knowledge entry.

**Approach:** 3 parallel Explore agents — (1) githooklib + githooklib-test + plst usage,
(2) flow, (3) serf + note/note2 + safe. Verify each claim (esp. the 6-digit version scheme,
"-d" detection rule, safe db record shape, conditional vercel/render config creation, master vs
main), then read the load-bearing files myself; ask the user only what code can't answer; write
the entry; update the know/README index line. RESULT below.

### RESULT — `deploy-slave` entry written from verified infrastructure code

Done. Explored directly (Explore agents were rate-limited): githooklib (README, both hooks,
version-utils, tag-utils), flow (webhook.ts, validation.ts, README), serf deploy.yml (full),
safe (README, openapi, routes, structuredController), note action.yml, note2 (listing), plst
usage (`git config core.hooksPath` currently UNSET in plst — hooks not active right now;
`build/package.json` has githooklib ^2.1.1).

**Corrections to the user's description, verified in code and written into the entry:**
1. "-d appended" → actually `.includes('-d')` anywhere in the message (tag-utils.js:58) — any
   message containing the substring deploys.
2. "6 digits" → 6-component tag `v{back.M.m.p}.{web.M.m.p}` in build/.env; per-folder
   package.json patch bumps happen on EVERY commit with folder changes, not only -d ones;
   -d only gates push+tag.
3. "flow sees what changed (back or web)" → not a file diff: flow compares the new tag's
   components against the repo's previous valid tag (validation.ts:57); back triple up → back,
   web triple up → web.
4. Two services the description omitted: **stat@** (per-stage deploy telemetry: PUSH_MASTER /
   GET_SAFE / PUSH_SLAVE / UNKNOWN) and **key@back** (optional runner-registration + scoped
   safe API key).
5. note (Timeweb example) triggers on **tag push**, not on 'main' — documented as-is.
6. safe's `/safe/get/v2` merges project_data EAV rows (stage DEPLOY/RUNTIME/SAFE, empty stage =
   all stages) + slave repo GIT_* + hosting SERVICE_*; vercel.json only for back (web carries
   its own), render.yaml both, env.js for surge; `.env`/`env.js` stripped from .gitignore so
   secrets commit into the private slave on branch `main`.

Entry: `know/entries/deploy-slave.md` (pipeline diagram, per-step mechanics with file:line
refs, conventions, deploy procedure, new-project checklist, verification via stat@/serf logs/
githooklib logs, gotchas incl. the `-d` substring trap and tag-collision failure). know/README
index line updated. Nothing committed (rule 5).
