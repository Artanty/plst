Round (user-amended): githooklib python versions (tested via `server/githooklib-test`); feat on the pipeline as python `back/`; serf `detect-tech-stack` step (all namespaces → `TECH_STACK` env, used by serf AND written into slave `.env`); serf VH-back via TECH_STACK; feat Cache-Control. **No safe changes** — stack info is detected, not stored.

## 1. githooklib python version support (`server/githooklib`)

- `lib/version-utils.js`: per-folder version source — `package.json` (unchanged) else `pyproject.toml` `[project] version` else single `__version__ = "…"` file. Reads (current/staged/HEAD via `git show`) and writes (patch bump, minor-reset → regex rewrite + `git add`) switch on detected source; missing web side already degrades to `0.0.0` (verified earlier). `package.json` → 2.2.0, CHANGELOG + README updated.
- **Tests live in `server/githooklib-test`** (user: "i created it especially for it"): inspect its current shape, extend to a python case — `back/` with `pyproject.toml` (no package.json): commit → pre-commit bumps patch in pyproject, `TAG_VERSION=0.0.N.0.0.0` in build/.env; `-d` commit → branch+tag pushed, web triple `0.0.0`; manual minor bump resets patch; node-side regression: existing package.json behavior unchanged. NOT `npm publish`-ed (user's login); feat uses `file:../../githooklib` meanwhile.

## 2. feat restructure (`server/feat`)

`back/` ← app.py, requirements.txt, features/ + new `pyproject.toml` (`[project] name="feat", version="0.0.1"`), NO package.json. `build/` with `file:../../githooklib` dep (npm install activates hooks). Root docs updated (README paths, AGENTS dev-server rule unchanged); branch `master`. Verify: hooksPath set; Flask (venv at `back/.venv`) serves `/` and `/version-display/v1/` from new layout.

## 3. serf `deploy.yml`: detect-tech-stack + VH-back

- New step **"Detect tech stack"** (all namespaces, after checkout): file/dep-based detection with precedence — `angular.json` → `angular`; `composer.json`|`*.php` → `php`; `pyproject.toml`|`requirements.txt`|`*.py` → `python`; else `package.json`: `vue` dep → `vue`, `react` dep → `react`, else `node`; bare `index.html` w/o package.json → `static`. Sets `GITHUB_ENV:TECH_STACK`; logged in the run output.
- `TECH_STACK=python` appended to the slave `.env` (Create .env step) — consumable by version-display later.
- **VH-back branch**: `SERVICE_DOMAIN=='VH' && namespace=='back' && env.TECH_STACK=='python'` → generated slave workflow: push to `main`, `get_env` SSH envs, **no build**, rsync whole dir to slot (exclude `.git`, `.github`, `.venv`, `__pycache__`; note's flags, 5 attempts) + best-effort `ssh … touch tmp/restart.txt` (Passenger). The "not implemented" throw now covers only unexpected combos (e.g. VH+back+node). Existing VH-web workflow untouched; no `${{ }}` in generated files.
- Script validation: outer YAML parses; both heredocs executed in temp dirs → inner YAMLs valid with expected steps.

## 4. feat router: Cache-Control

Versioned `/<feature>/v<n>/…` → `public, max-age=31536000, immutable`; `/latest`, `/manifest.json` → `no-cache`. Verified via curl headers.

## 5. Docs & logs

- know: `deploy-slave.md` (TECH_STACK step, VH-back path, python versioning) + `feat.md` (pipeline deploy, tag shape `v0.0.N.0.0.0`) updated.
- DECISIONS: githooklib (has its own?), feat, serf, plst (cwd) — plan before/result after each.
- User checklist: create feat GitHub repo + install flow App + safe records (slave repo, VH hosting, 4 SSH envs incl. single-line key); `npm publish` githooklib 2.2.0 when satisfied.
- Nothing committed anywhere.