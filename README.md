# plst

Music library: scan Yandex Music tracks (browser extension), import them into a shared library,
build playlists, match songs to YouTube Music, export links. Web app + browser extension +
two interchangeable backends (python = current, node = frozen behavioral reference).

## Folders

| Folder | What it is |
|---|---|
| `back/` | **the backend (python/Flask)** — the one to run |
| `back-node-js/` | the previous node backend, kept runnable as the behavioral reference |
| `web/` | the web app (React + vite) |
| `web-angular/` | an Angular mirror of the web app |
| `ext/` | browser extension (scanner + popup) |
| `feat` (../feat) | remote web-component library the web app loads features from (vendored server libs come from it too) |
| `build/` | tooling seat (githooklib hooks: version bumps + `-d` deploy tagging) |

## Prerequisites

- Node 22+ and Python 3.9+
- MySQL reachable (the `.env` points at it; local dev MySQL: `brew services start mysql`)
- Each backend reads its own `.env` — see the matching `.env.example` (`back/.env.example`,
  `back-node-js/.env.example`, `web/.env.example`)

## Run the backend (python — current)

```bash
cd back
python3 -m venv venv                      # once
venv/bin/pip install -r requirements.txt  # once
venv/bin/python app.py                    # serves HOST:PORT from .env (default 0.0.0.0:3218)
```

## Run the backend (node — reference)

```bash
cd back-node-js
npm install        # once
npm run dev        # tsx watch on :3218 — same port/protocol, pick ONE backend at a time
```

Both read the same env keys and speak the same API on the same port — the web app cannot tell
them apart. To switch: stop one, start the other.

## Run the web app

```bash
cd web
npm install        # once
npm start          # vite on http://localhost:5173 (BACK_URL from web/.env, default localhost:3218)
```

The Angular mirror: `cd web-angular && npm install && npm start`.

## Browser extension

Load `ext/` as an unpacked extension (chrome://extensions → Developer mode → Load unpacked).
It scans Yandex Music pages and POSTs tracks to the backend (`/api/library/scan`), with the user
id set in the popup.

## Tests

```bash
# python backend
cd back && venv/bin/pytest test -q          # needs local MySQL up (brew services start mysql)

# node backend (reference)
cd back-node-js && npm test

# web app
cd web && npx vitest run

# extension
cd ext && npm test
```

## Shared server libraries come from feat

`back/lib/` (logger, ext-log, db-diag) is **vendored** from the feat project
(`../feat/back/features/*/v1/py/`), whose specs live in `../feat/back/spec/`. Edit there, then:

```bash
cd back && python3 scripts/sync_features.py
```

## Useful diagnostics

```bash
cd back
venv/bin/python cli_db.py               # is the DB reachable? full ladder + fix-it SQL
venv/bin/python scripts/logs.py --last 200          # tail backend logs (--errors, --ext, --no-follow)
venv/bin/python scripts/logs.py --ext --last 100    # extension logs as shipped to the server
```

(Or over HTTP: `curl "http://localhost:3218/api/library/logs?last=60"`.)

## Deploy

Committing is hooked: githooklib auto-bumps versions (`back/pyproject.toml`,
`back-node-js/package.json`, `web/package.json`), and a commit message containing `-d` pushes,
tags, and triggers the deploy pipeline. Never commit secrets; `input/` stays untracked.
