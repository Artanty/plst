jump = public, self-bootstrapping node backend on the VDS, with first-class logging: app owns the WHAT (bootstrap + observability), systemd owns the WHEN (kept: boot/crash/deploy restart; deploy script only syncs + restarts).

## 0. Clean slate (one VDS session per contract): `userdel -r jump`

## 1. `~/server/jump/back` — node backend (public-repo-safe) + logging

- `package.json`: express + dotenv; `start`: `node app.js`; `build`: noop; `version 0.0.1` (githooklib source). Plain JS.
- `lib/log.js` — tiny logger: timestamps, levels (info/warn/error), writes to stdout (journald captures it: `journalctl -u jump` reads it forever) AND keeps a bounded in-memory ring buffer (last ~200 lines) for the `/logs` endpoint.
- `lib/bootstrap.js` — idempotent user/key ensure via `execFileSync` (args as arrays — no shell interpolation): each step logged with outcome — `user exists`, `useradd ok`, `.ssh ok`, `key line already present (no-op)` / `key line appended`, perms fixed; result summary logged; on failure logs the failing step + stderr and returns an error.
- `app.js`: dotenv → **before `app.listen`**: run bootstrap (logged), store result; endpoints: `GET /healthz` → `ok`; `GET /status` → `{ok, userExists, keyPresent, options, bootstrappedAt, uptime, node version}`; `GET /logs` → ring buffer (plain text); request logging (method/path/status/ms) at info. Bootstrap failure → log + exit 1 (systemd state = failed, visible; journal has the cause).
- README (architecture, env table, public-safety note, local dev, how to read logs — `journalctl -u jump -f` or `/logs`). Private `.jump_key`(+`.oneline`) local-only gitignored. `build/` githooklib seat + npm install; tags `v0.0.N.0.0.0`.

## 2. serf: VDS-back generation split by prisma presence (generation-time check of `$WORKING_DIR/prisma/schema.prisma`)

- with prisma → totp's exact workflow (unchanged).
- without → slim: checkout → dotenv→GITHUB_ENV → env validation → `npm ci` → `npm run build` → scp whole folder to `/root/$SLOT/` → ssh: `npm install --omit=dev`, ensure systemd unit (`WorkingDirectory=/root/$SLOT`, `ExecStart=/usr/bin/env node app.js`, `Restart=always`) if missing, `daemon-reload`, `restart $SLOT`, 5-line status (so the deploy log itself shows healthy/failed).
- `${{ '${{' }}` escapes; script-validated both variants (outer YAML, heredoc execution, inner YAML).

## 3. Acceptance (user): safe rows (SSH_HOST/SSH_USER=root/USER_PASS/REVERSED_PROXY_SLOT=jump/JUMP_USER/JUMP_PUBLIC_KEY/JUMP_KEY_OPTIONS) + public jump repo + flow App; commit+push serf; `-d` → deploy restarts service → startup recreates the deleted user (watch it live via the deploy's status output or `journalctl`/`/logs`); re-verify chain (ssh through jump → cs99850), then jump envs for feat/plst.

know updates (vds-jump-host: node service + envs + logging runbook; deploy-slave: prisma-split) + DECISIONS logs (jump/serf/plst). Nothing committed by me.