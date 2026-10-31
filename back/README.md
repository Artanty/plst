# plst — Yandex Music → YouTube Music links

Web service that converts Yandex Music playlists, liked tracks, and albums into
**YouTube Music links** — no YouTube-side auth or writes; you get match reports
and link lists you can paste anywhere.

Source metadata is pulled from the Yandex Music API (anonymous for public
playlists/albums, token for private ones). Tracks are matched via
[ytmusic-api](https://github.com/zS1L3NT/ts-npm-ytmusic-api) song search with
fuzzy title/artist scoring and a duration sanity check.

## How matching works

For every Yandex track we build search queries (`artist title`, `title artist`,
a transliterated variant for Cyrillic names, secondary artist) and score
candidates:

```
score = 0.6 * title_similarity + 0.4 * artist_similarity   (WRatio)
score *= 0.3 if |duration difference| is outside tolerance
```

* `score >= MATCH_ACCEPT` → **matched**
* `MATCH_UNCERTAIN <= score < MATCH_ACCEPT` → **uncertain** (shown, flagged)
* below → **not_found**

Matches are cached in **MySQL**, so re-runs after a failure don't re-search.

## Setup

Requires Node ≥ 20.18 (`.nvmrc` pins 20; `nvm use` if you use nvm).

```bash
npm install
cp .env.example .env     # fill secrets/tuning (see below)
```

The app persists jobs, per-track results, and the match cache in **MySQL**.
Configure it in `.env` with the individual parts `DB_HOST`, `DB_PORT`
(3306), `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`. Tables are created
automatically on startup.

### Yandex token (optional — public playlists/albums work without it)

```bash
node scripts/get_yandex_token.mjs   # OAuth device flow, prints access_token
# put it into .env as YANDEX_TOKEN=...
```

### Proxies

Servers that cannot reach YouTube directly (e.g. in Russia) set
`YTM_PROXY=http://user:pass@host:port` — applied to YouTube Music requests only.
`YANDEX_PROXY=http://...` covers the reverse case. Both are optional.

## Run

```bash
npm run dev              # tsx dev mode
npm start                # tsx src/server.ts — no build step, works on bare npm install
npm run build && node dist/server.js   # optional compiled build
# open http://<host>:8000
```

Bind to `0.0.0.0` (default) so the platform health check can reach the app;
override with `HOST` if needed.

## CLI dry-run (prints links, writes nothing)

```bash
npm run match -- https://music.yandex.ru/users/<user>/playlists/<kind>
# or: npx tsx src/cli.ts match <url>
```

## Modes

| Mode | Input | Needs token? |
|---|---|---|
| Playlist (URL) | `music.yandex.ru/users/<u>/playlists/<k>` | only if private |
| Album (URL) | `music.yandex.ru/album/<id>` | no |
| Liked (user) | Yandex username | yes |
| Saved albums (user) | Yandex username | yes |
| All playlists (user) | Yandex username | yes |

Each job page shows a per-track report with links, plus `?format=links`
(plain-text list) and `?format=json` exports.

## Tests

```bash
npm test
```

## Notes

* Both APIs are unofficial; versions are pinned in `package.json`. If a
  migration fails, check the `jobs` table in MySQL — per-track results
  survive restarts.
* If the server can't reach YouTube, searches time out after `YTM_TIMEOUT`
  (default 20 s) and retry ×3, then the track is reported `not_found`.
