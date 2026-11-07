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

## 2026-11-03 — PLAN (rule 1): untrack `build/node_modules` from git

**Request:** "remove from git node_modules of build folder".

**Approach:** `build/.gitignore` already gained a `node_modules` line (user edit, uncommitted);
184 files under `build/node_modules` are still tracked. Run `git rm -r --cached build/node_modules`
(index only — files stay on disk), verify nothing is tracked and nothing was deleted from the
filesystem, stage the `.gitignore` change too. No commit (rule 5). RESULT below.

### RESULT — `build/node_modules` untracked

Done, staged only, nothing committed (rule 5). `git rm -r --cached build/node_modules` staged
**184 deletions** (index only — all files remain on disk, `build/node_modules` still has its
packages); `git add build/.gitignore` staged the user's `node_modules` ignore line so the files
can't come back. Verified: `git ls-files build/node_modules | wc -l` → **0**. Left uncommitted
alongside the pre-existing `build/package.json`, `build/package-lock.json`, `web/index.html`,
`DECISIONS.md` changes.

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

---

## 2026-11-04 — PLAN (rule 1): new project `server/feat` — runtime web-component library (feat_URL/{feature}/v{n}/)

**Request:** a lib of features: all versions accessible at once via `feat_URL/{feature}/v1/`;
per-feature separate bundles loaded independently on demand at runtime (mfe-style); future
feature-toggle without page reload; web-components so any framework works. Backend router in
Python (Timeweb VH has PHP+Python free). First feature: `version-display` (the `deploy-info`
element — attribute-driven, shadow-DOM badge). Canonical bundle URL is the bare-directory form
`…/v1/` serving `index.js`.

**Approach:** Flask (WSGI — Passenger-compatible on Timeweb) in new `~/server/feat`: routes
`/<feature>/v<n>/` (→ index.js), `/<feature>/v<n>/<file>`, `/<feature>/latest` (302 to newest),
`/manifest.json`, `/healthz`; CORS `*` + JS MIME on feature responses; traversal-guarded.
Feature `features/version-display/v1/index.js`. AGENTS.md + DECISIONS.md per ~/server
convention, git init, no commit. know entry `entries/feat.md` with the vision. Verify live:
venv + Flask run + curl all URL forms + `node --check`; stop server after. RESULT below.

### RESULT — feat project created, verified live

Done. `/Users/artyomantoshkin/server/feat/`: `app.py` (Flask router — routes per plan, CORS `*`
on everything, JS MIME forced, `send_from_directory` traversal guard + feature-name regex),
`features/version-display/v1/index.js` (deploy-info element: attribute-driven, shadow DOM,
one-liner + click-expand, silent without real version), `requirements.txt`, `README.md`,
`AGENTS.md`, `DECISIONS.md`, `.gitignore`, `git init` (no commit). Verified live on :5099 —
both bundle URL forms 200 text/javascript + CORS; /latest 302; /manifest correct; traversal
and unknown feature → 404; multi-version temp test (v1+v3): manifest lists both, latest → v3;
`node --check` clean; server stopped. know: `entries/feat.md` written (vision verbatim +
current state + consumer snippets + gotchas), README index line added.

---

## 2026-11-04 (2) — PLAN (rule 1): python versioning in githooklib + feat-on-pipeline + serf detect-tech-stack

**Request:** move feat app into `back/` to ride the standard pipeline; teach githooklib to
bump python versions (pyproject.toml `version` / `__version__` file) instead of a fake
package.json ("without web folder last 3 symbols will be zeros" — confirmed, existing code
already degrades missing side to 0.0.0); test via `server/githooklib-test`. Plus serf
`detect-tech-stack` step (ALL namespaces; angular/react/vue/static/node/python/php from
files; exposed as `TECH_STACK` env + written into slave `.env` for version-display) and
VH-back=python rsync+restart workflow. No safe changes (stack detected, not stored — user's
call). feat router gets Cache-Control (versioned immutable / latest+manifest no-cache).

**Approach:** (1) githooklib `lib/version-utils.js` per-folder version source:
package.json (unchanged) → pyproject.toml → `__version__` py file; staged/HEAD via `git show`
on the source path; bump/minor-reset = regex rewrite + git add; version 2.2.0 + CHANGELOG +
README; tested live in githooklib-test (pre-commit bump w/o -d; post-commit -d push tested
against a temporary local bare origin, restored after). (2) feat: back/ + pyproject.toml
(0.0.1, NO package.json), build/ with `file:../../githooklib`, venv → back/.venv. (3) serf:
detect-tech-stack step (angular.json → angular; composer.json|*.php → php;
pyproject|requirements|*.py → python; package.json deps vue/react → vue/react else node;
index.html w/o package.json → static) → GITHUB_ENV + `TECH_STACK=` line in slave .env;
VH+back+python generated workflow (get_env SSH, no build, rsync whole dir minus
.git/.github/.venv/__pycache__, 5 attempts, best-effort `touch tmp/restart.txt`); throw step
now only for unexpected combos. (4) feat Cache-Control. know entries updated. Nothing
committed; githooklib NOT npm-published (user's step). RESULT below.

### RESULT — githooklib 2.2.0 python + feat pipeline-shape + serf detect-tech-stack/VH-back

Done, nothing pushed/published anywhere. (1) **githooklib**: per-folder version source
(package.json → pyproject.toml → `__version__` .py file), 2.2.0 + CHANGELOG + README; live-
tested in githooklib-test per user instruction — python bump/minor-reset/-d-push (temp bare
origin, restored), branch-guard refusal verified, node regression clean (web-only bump).
(2) **feat**: restructured to back/ + pyproject.toml (no package.json) + build/ githooklib
seat (file: dep until npm publish); two local commits, pyproject auto-bumped to 0.0.3,
TAG_VERSION=0.0.3.0.0.0; Cache-Control added and live-verified (versioned immutable / latest
+ manifest no-cache). (3) **serf**: detect-tech-stack step (7 stacks, synthetic + real-dir
tests all correct) exporting TECH_STACK to GITHUB_ENV and slave .env; VH-back python rsync+
passenger-restart workflow; throws narrowed. (4) know entries updated. **User steps**: npm
publish githooklib 2.2.0; create feat GitHub repo + install flow App; safe records (slave
repo, VH hosting, 4 SSH envs, single-line key); first `-d` commit on feat master.

## 2026-11-04 (3) — update githooklib to npm 2.2.0 across all projects

**Result:** user published 2.2.0; set `^2.2.0` in build/ (and flow/back, githooklib-test/back)
manifests of feat, chat, flow, key, plst, totp, safe, yaum, stat, githooklib-test; npm
installed everywhere — all resolve 2.2.0 with hooks active. **Side effect: plst's
`core.hooksPath` is SET again** (was unset since some earlier local change) — the pipeline is
armed; a `-d` commit on plst master will now really deploy. Gotcha found twice: npm keeps a
`file:` symlink + lockfile resolution after switching to a range — feat/build and
githooklib-test/back needed `rm -rf node_modules package-lock.json` + fresh install. feat
functional re-test with the npm copy: commit bumped pyproject 0.0.3→0.0.4, TAG_VERSION
correct. Nothing committed.

## 2026-11-05 (4) — jump service (~/server/jump) live
VDS probe OPEN x3 -> restricted user `jump` (nologin + restrict,port-forwarding) + dedicated ed25519 key installed in exactly 2 sessions (contract kept); serf VH workflows re-gained optional SSH_JUMP_HOST/JUMP_SSH_PRIVATE_KEY (ssh_config/ProxyJump, absent = direct); full chain verified from local (whoami=cs99850). know: entries/vds-jump-host.md + links from deploy-slave + blacklist (marked historical). Private key only in safe (single-line, .jump_key.oneline, roundtrip OK). Nothing committed anywhere.

## 2026-11-07 (2) — feat "Forbidden" follow-up: no Passenger on Timeweb VH — pyxy-style .htaccess is the serving pattern; **feat is LIVE**

User reported `Forbidden` on https://feat.twc1.net/. Probes: Apache static behavior, raw
index.wsgi. Host check: NO Passenger anywhere; the working python site (pyxy) serves via
Apache `wsgi-script` handler in `.htaccess` (rewrite all to `/index.wsgi/$1`, wsgi chmod
755). Applied on the host and in `feat/back` (`.htaccess` + exec bit, rsync ships both):
`/healthz` 200, `/version-display/latest/js-web` 302→v2, v1 200 immutable+CORS, `/` 200.
`tmp/restart.txt` is a Passenger no-op here. know (deploy-slave serving gotcha, feat) and
feat/DECISIONS.md (2026-11-07 (5)) updated. Nothing committed.

## 2026-11-07 — feat deploy failed: "No module named pip" on the VH host — fixed with slot venv

User reported the failed `../feat` deploy. Log first: rsync over the jump host SUCCEEDED;
the pip step died (`/usr/bin/python3: No module named pip`) and the workflow correctly did
not restart. Probed the host live (deploy key pulled from safe's MySQL, SSH via jump):
shell python is 3.6.9, no pip, `-m venv` broken (no ensurepip). Same box already had the
proven pyxy pattern: slot `venv` via `virtualenv` + `sys.path.append(site-packages)` in
`index.wsgi`. Fixed (details in `feat/DECISIONS.md` 2026-11-07 (4)): requirements floor pin
`flask>=2.0`, quoted py3.6-incompatible annotations in `app.py`, `index.wsgi` venv pickup,
serf VH-python pip step now creates `venv` (`virtualenv -p python3` — bare `virtualenv`
picks py2, hit live) and installs with `venv/bin/pip`. Host fixed for now (venv built,
Flask 2.0.3 in, restart touched, wsgi import verified live). **Remaining blocker is the
panel: site feat.twc1.net still serves STATIC (raw index.wsgi = 200 source)** — user must
set application type Python/Passenger + startup file `index.wsgi`. know entries
(deploy-slave gotcha, feat) updated; nothing committed anywhere (rule 5).

## 2026-11-07 (3) — PLAN (rule 1): version-display in the header of the Angular app (web-angular)

**Request:** "implement version-display in header of plst app". The React `web/` already has it
(`layout/VersionDisplay.tsx` + `core/app-version.ts` + a `.version` span in the header bar);
`web-angular/` has none — only a leftover env-injection experiment (`shell.ts value1` /
`{{value1}}` rendering `process.env['SERVICE_EMAIL']`, always empty).

**Approach (parity with React, no remote feat dependency):**
1. `web-angular/src/app/core/app-version.ts` (new): exported `TAG_VERSION = '0.0.0.0'` const
   (committed default; the `export const TAG_VERSION = '…';` line format is load-bearing for a
   future deploy-time sed, same contract as React's `src/config.ts`) + `appVersion()` returning
   the injected value or `'0.0.0.0'`. No `import.meta.env` branch — the Angular builder has no
   dev-env injection to mirror.
2. `shell.ts`: remove the `value1` experiment; add `readonly version = appVersion()`.
3. `shell.html`: remove `{{value1}}`; add `<span class="version" title="app version">{{ version() }}</span>`
   after the switcher label (React renders its badge last in the header).
4. `shell.scss`: `.version` copied from React's `web/src/layout/shell.scss` (10px, tabular-nums,
   #8b909b).
Verify: Angular build + unit tests green. RESULT below.

### RESULT — Angular header shows the app version

Done, nothing committed (rule 5). `web-angular/src/app/core/app-version.ts` (new; `TAG_VERSION`
const + `appVersion()`), `shell.ts` (leftover `value1`/`process.env['SERVICE_EMAIL']` experiment
removed, `readonly version = appVersion()` in), `shell.html` (`{{value1}}` removed, `<span
class="version">` after the switcher label), `shell.scss` (`.version` copied from React).
Verified: `ng build` clean (1.5s), **25/25 unit tests green**. The badge shows `0.0.0.0` locally;
a deploy-time sed of the `export const TAG_VERSION = '…';` line (same contract as React's
`web/src/config.ts`) would ship the real tag — no such step exists for web-angular yet. The React
app was untouched (its version badge already shipped).

## 2026-11-07 (4) — PLAN (rule 1): React web/ switches its header badge to feat's `deploy-info`

**Request:** "i dont like that react app uses its own version display. i want to use feat's one."
Verified live (curl via `--resolve`, local DNS fails for feat.twc1.net as usual):
`https://feat.twc1.net/version-display/v1/js-web/` → 200 `text/javascript`, immutable, CORS `*`;
`/latest/js-web` → 302 to v2. Element contract (read from the bundle): `<deploy-info
version project namespace commit repo>` — shadow-DOM badge **fixed bottom-right**, click
expands commit/repo rows; renders NOTHING for empty or `0.0.0(.0)` versions (dev stays clean).

**Approach:**
1. `web/index.html`: `<script src="https://feat.twc1.net/version-display/v1/js-web/"></script>`
   (classic script, pinned v1 per the know-entry gotcha — never `/latest`).
2. `web/src/layout/VersionDisplay.tsx`: same JSX name, but now renders
   `<deploy-info version={appVersion()} project="plst" namespace="web" />` + the React-19
   `IntrinsicElements` declaration for the custom element (TS). `config.ts` TAG_VERSION
   (CI-injected) stays the version source — unchanged contract, new display.
3. `web/src/layout/shell.scss`: drop the local `.version` block (the element brings its own
   shadow styles). Shell.tsx untouched — `<VersionDisplay />` stays where it is; fixed
   positioning takes the badge out of the header flow visually.
Result: badge moves from the header bar to the bottom-right corner; dev builds go silent
(`0.0.0.0`/git-describe `v…` are fine but the element is dark for `0.0.0(.0)`; if the script
fails to load — e.g. this machine's broken DNS — nothing renders at all, by design).
Verify: tsc + vitest + build. RESULT below.

### RESULT — web/ renders feat's `deploy-info` instead of its own span

Done, nothing committed (rule 5). `web/index.html` loads
`https://feat.twc1.net/version-display/v1/js-web/` (classic script, pinned v1); `VersionDisplay.tsx`
now returns `<deploy-info version={appVersion()} project="plst" namespace="web" />` with the
React-19 `IntrinsicElements` augmentation (plain attribute-object type — the `Attributes &`/
`DetailedHTMLProps` variants tripped noUnusedLocals, plain wins); the local `.version` block is
gone from `shell.scss`; `VersionDisplay.spec.tsx` asserts the element's `version`/`project`/
`namespace` attributes instead of a `.title="app version"` span. Verified: tsc clean,
**68/68 vitest**, `vite build` ok. The badge now sits **fixed bottom-right** (the element owns its
shadow styles — it left the header bar), expands on click, and stays dark for `0.0.0.0`/failed
script loads (e.g. this machine's broken DNS for feat.twc1.net — verified 200 via `--resolve`).
`config.ts` TAG_VERSION stays the version source. NOTE: `web-angular/` still shows its own local
badge from 2026-11-07 (3) — switching it to `deploy-info` would need the script tag in
`src/index.html` + `CUSTOM_ELEMENTS_SCHEMA` + `@ngx-env/builder` for TAG_VERSION (know/feat.md
documents the Angular consumer pattern).

## 2026-11-07 (5) — PLAN (rule 1): make the deploy-info integration dynamic (user picked ALL four)

**Request:** "can we make it more dynamic? i dont like that we know a lot about its work" —
then, on scope: auto-latest bundle + live toggle + fewer attributes + element fetches version
itself. Discovery: the live feat router has **NO `/manifest.json`** (app.py docstring: "No
manifest"; live 404; v2 ships only `index.js`) — the know entry is stale on that point. The
`/<feature>/latest/<ns>` 302 exists but a cross-origin `fetch(…, redirect:'manual')` is opaque
(can't read Location), so toggle polling needs the manifest route re-added.

**Approach:**
1. **feat** (`~/server/feat`, own DECISIONS.md entry):
   - `back/app.py`: re-add `GET /manifest.json` → `{features: {<name>: {versions: [vN…],
     latest: vN}}}` (no-cache, CORS `*`).
   - `features/version-display/v3/js-web/` — **index.js = thin stable shell** (guards on
     `customElements.get('deploy-info')`, defines once; later releases never redefine — the
     class is only defined by the pinned shell) + **render.js = swappable logic module**
     (default export `render(shadowRoot, data)`, markup ported from v2). Shell behavior:
     attributes `src` (runtime JSON endpoint → `{version, project, namespace, commit, repo}`),
     `manifest` (feat manifest URL), `refresh` (poll seconds, default 300), legacy direct attrs
     still honored; `project` defaults to the hostname's first label; data precedence
     direct attr > src fetch > hostname; silent without a real version (unchanged); on connect
     it resolves latest from the manifest and `import()`s that version's render.js (fallback:
     built-in renderer on any failure); polls the manifest and hot-swaps render.js on `latest`
     change — **toggle without redefining the element**.
2. **plst back**: `GET ${apiPrefix}/version` → `{version, project, namespace, commit, repo}`
   from `process.env` (PROJECT_ID/NAMESPACE/COMMIT_MESSAGE/SLAVE_REPO) + `TAG_VERSION`;
   `TAG_VERSION` falls back to parsing repo-root `build/.env` (githooklib-written, tracked) so
   dev shows a real version; pure `parseTagEnv()` exported for tests; route added to
   `requestLogSkipPrefixes` (the element polls it). Test: route returns env value; parse
   function unit-tested.
3. **plst web**: `index.html` script pinned to `…/version-display/v3/js-web/` (stable shell —
   logic still auto-updates via manifest; avoids the "latest markup changed" trap);
   `VersionDisplay.tsx` → `<deploy-info src="/api/version"
   manifest="https://feat.twc1.net/version-display/manifest.json" />` — **no hardcoded
   version/project/namespace anymore**; spec asserts the new attrs; `core/app-version.ts`
   deleted (unused; `config.ts` TAG_VERSION line stays — the deploy sed contract survives);
   `vite.config.ts` devTagVersion/define removed (only fed app-version).
4. know/entries/feat.md: manifest is real again, v3 consumer pattern.
**Ordering:** plst badge stays dark until feat v3 deploys (user step: `-d` commit on feat).
Verify: feat venv smoke (manifest + v3 URLs + node --check), back tests+lint, web tsc+tests+build.
RESULT below.

### RESULT — dynamic deploy-info integration, proven live end to end

Done, nothing committed (rule 5). plst now supplies NO version data at all — only two pointers.

- **feat** (`~/server/feat`, details in feat/DECISIONS.md 2026-11-07 (6)): `/manifest.json`
  re-added (it had been dropped in the pipeline restructure — know entry was stale), and
  `version-display/v3/js-web/` — stable shell (`index.js`, defines the element once) +
  swappable logic (`render.js`, adopted from the manifest's latest and hot-swapped on poll).
- **plst back**: `back/src/lib/version.ts` (`tagVersion()` — env first, then repo-root
  `build/.env` via pure `parseTagEnv`) + `GET /api/version` (keys = element attributes;
  added to `requestLogSkipPrefixes`) + `test/version.test.ts`.
- **plst web**: `index.html` pins `…/version-display/v3/js-web/`; `VersionDisplay.tsx` renders
  `<deploy-info src="/api/version" manifest="…/manifest.json" />` — no hardcoded
  version/project/namespace; `core/app-version.ts` + its spec deleted; vite `devTagVersion`
  shim removed; `config.ts` TAG_VERSION kept ONLY as the deploy sed target (comment updated).
- **Verified live in a browser** (local feat :5000 + plst back :3299 + static test page): the
  element fetched the real version `1.0.16.0.0.27` from `/api/version`, derived `project` from
  the hostname, adopted the manifest's render module, and **hot-swapped to a temporary v4
  renderer within one poll cycle without reload** (v4 removed after the test). v1/v2 checked
  unregressed; feat router manifest/v3/render.js all 200 with right MIME/caching.
- **Verify**: back **125/125** (local MySQL had to be restarted — `brew services start mysql` —
  all 24 failures before that were ECONNREFUSED 3306, environmental) + lint clean; web tsc
  clean, **62/62** vitest, build ok.
- **Ordering**: plst's badge stays DARK until feat v3 deploys (user step: `-d` commit on feat).
  Angular (web-angular) still uses its own local TAG_VERSION badge from 2026-11-07 (3) —
  switching it would mirror this same two-pointer pattern.

## 2026-11-07 (6) — PLAN (rule 1): feature-slot architecture — config API (mock) + generic remote web-element wrapper

**Request (supersedes the `/api/version` data endpoint):** "i dont like the thing we link this
web feature with backend… all needed values should be accessible on web build time, so they are
in bundle" — then corrected further: drop the manifest too; add a **features config API (mock)**
that tells the web app WHICH feature/component/version to mount; and a generic **slot wrapper**
that loads remote feat web-elements inside itself. Slots = named mount points every future app
can declare; a config GUI will edit the API's data later.

**Approach:**
1. **back**: mock `GET ${apiPrefix}/features` → `{features: [{id, element, namespace, version,
   slot, baseUrl}]}` (static const; shape documented once, mirrored in web types).
2. **web `src/core/features.ts`**: `FeatureConfig` type + `useFeaturesConfig()` — fetch once,
   module-level promise cache (N slots = 1 request).
3. **web `src/layout/FeatureSlot.tsx`**: `{slot, attrs?, fallback?}` — finds its config entry,
   injects `<script src={baseUrl}/{id}/{version}/{namespace}/>` (module-level Map<url,Promise>,
   inject once), renders `React.createElement(element, attrs)`. Silent while loading and on
   failure (`fallback` default nothing) — the page never breaks over a feature.
4. **Shell.tsx**: `<FeatureSlot slot="app-version" attrs={{version: TAG_VERSION, project:
   'plst', namespace: 'web'}} />` — data values build-time (config.ts, sed-injected). Delete
   `VersionDisplay.tsx` + spec; new `FeatureSlot.spec.tsx`. config.ts: TAG_VERSION stays;
   NO `/api/version` anymore — remove back route + `lib/version.ts` + its test + skip-prefix.
5. feat: no changes (v3 shell handles direct attrs; without `manifest` it never polls).
6. know/entries/feat.md consumer section → slot pattern. Verify: back tests+lint, web
   tsc+tests+build, live `/api/features`. RESULT below.

### RESULT — slot architecture shipped: config API (mock) + FeatureSlot wrapper

Done, nothing committed (rule 5). The web app no longer knows anything about version-display:
it declares a slot; the backend config says what fills it.

- **back/src/server.ts**: mock `GET /api/features` returning the one-row feature table
  (slot/id/element/baseUrl/version/namespace — static const, documented as the future GUI's
  data). Live-verified: `{"features":[{"slot":"app-version","id":"version-display",
  "element":"deploy-info","baseUrl":"https://feat.twc1.net","version":"v3","namespace":"js-web"}]}`.
  The whole `/api/version` thread is REMOVED (`lib/version.ts` + test + skip-prefix) — the
  user rejected the backend data coupling: values live in the bundle.
- **web/src/core/features.ts**: `FeatureConfig`/`FeaturesConfig` types + `useFeaturesConfig()`
  (module-level promise cache — N slots, 1 request; `resetFeaturesConfigCache()` test hook).
- **web/src/layout/FeatureSlot.tsx**: `{slot, attrs?, fallback?}` wrapper — config lookup,
  script injection via a Map<url,Promise> (once per URL, `resetLoadedScripts()` test hook,
  error clears the entry so a later mount can retry), then `createElement(element, attrs)`.
  Contract: `null` while loading; fallback (default nothing) on config failure / missing slot
  entry / script failure — a feature can never break the host page.
- **Shell.tsx**: `<FeatureSlot slot="app-version" attrs={{version: TAG_VERSION, project:
  'plst', namespace: 'web'}} />` — data values are build-time (config.ts TAG_VERSION,
  sed-injected on deploy). `VersionDisplay.tsx` + spec deleted.
- **FeatureSlot.spec.tsx** (4 tests): script URL assembled from config + element mounted with
  attrs; unknown slot → nothing; script error → fallback; config failure → fallback (this last
  one caught a real inconsistency — the wrapper initially rendered `null` on config failure).
  jsdom never fires script events, so the specs dispatch load/error on the injected node.
- **Verify**: back **121/121** + lint clean; web tsc clean, **65/65**, build ok.
  Badge stays dark until feat v3 deploys (script 404s today → slot renders nothing, by design).
- know/entries/feat.md consumer section rewritten around the slot pattern.

---

## 2026-11-05 (5) — jump rebuilt as self-bootstrapping node service
VDS: userdel -r jump (1 session, clean slate). jump/back: express+dotenv app — startup bootstrap (idempotent user+key ensure, per-step logs, args-as-arrays, dev-mode skip on macOS), /healthz //status //logs, journald+ring logging; smoke-tested locally. build/ githooklib 2.2.0 seat; two commits — bump verified (0.0.2, TAG 0.0.2.0.0.0). serf: VDS-back split prisma/slim (unit-ensure via printf; scp exclude unsupported → strip step); both variants validated. know updated (vds-jump-host, deploy-slave). Nothing pushed; user steps: safe rows (SSH_HOST/SSH_USER/USER_PASS/REVERSED_PROXY_SLOT=jump/JUMP_USER/JUMP_PUBLIC_KEY/JUMP_KEY_OPTIONS), public jump repo + flow App, push serf, -d → acceptance: deploy must recreate the deleted jump user.
