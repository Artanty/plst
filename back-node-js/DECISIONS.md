
## 2026-09-21 progress (rule 2)
e2e now REAL-headed and the 403 root REAL-diagnosed: running server (PID 10002/3, started 10:38) predates the token in .env; dotenv evaluates at import so the long-lived process is anonymous → album WAF-403. Restart-with-current-.env is the fix (unchanged plan). Playwright chromium runs fine under nvm Node 20 (v20.19.5); bare-shell 18.20.8 kills the whole process via playwright bootstrap, NOT WAF. DECISIONS.md at 267 lines → needs trim (rule 4 flag).

## 2026-09-21 later · TERMINAL on the 403 (live, headed browser, owned token)
The album job ends **failed: "Yandex API HTTP 403 for /albums/1193829/with-tracks"** — reproduced through the app's own
YandexClient (OAuth, token OWNS 1193829, `yandex_configured:true` → token IS in the live process). The 403 is
**endpoint-WAF on `/albums/{id}/with-tracks`**, NOT ownership auth: the same token/anonymous client returns 200 for
`/albums/{id}` (plain) and only `with-tracks` trips WAF. So the DECISION 2026-09-20 "token must own the playlist" is
REQUIRED-but-not-SUFFICIENT: ownership fixes 404/401-but-403-on-public-album stays. The migrator must not hard-require
`with-tracks`; it should fall back to plain `/albums/{id}` (+ batched `/tracks` fetch) when `with-tracks` WAF-403s, which
is a product change → recorded as such (this is why the album positive control is currently `failed`, not a test bug).
PLAN 2026-09-21 (user chose "1"): albumWithTracks() gets a 403 fallback — on Yandex API 403 for
/albums/{id}/with-tracks, fetch plain /albums/{id}, read volumes of track ids, batch via existing
tracks(ids) 50/batch, rebuild {volumes:[trackObj...]} so albumTracks()/pipeline stays untouched.
Applied in client.ts only. Contract unchanged at /migrate (album positive control must reach done).
PLAN 2026-09-21 (rule 1 before code): user hit "HTTP 403 for /playlist/4f7b10fe-a3dd-6acd-aece-ce1ffd23ca26".
DETERMINE, don't assume: (1) start server under tsx+nvm20, (2) probe that EXACT share through the
APP's own YandexClient.playlistShare() with the live token, capture HTTP code WHO + headers, (3) if
403 persists with the source-owner token => it is the WAF/IP-flag contract (album positive control
proved this session: same host Flagged, plain album flips 200->403 after probe spree). Answer
honestly: if token does NOT own that playlist, NO code fix exists — Yandex-side ownership+WAF; the
only lever is a token that owns it or a cool-down host. No commit, no assumption (rule 5 ✓).

2026-09-21 · last check: server DOWN (killed prev turn), port 8000 confirmed free. User asked "can we fix 403
for /playlist/4f7b10fe?" and "see logs" — but there are NO fresh logs (server stopped BEFORE the question).
Honest answer delivered: playlistShare 403 = Yandex ownership/WAF contract (rule 2026-09-20: token must OWN
the playlist) + this host IP-flagged for Yandex (proven live earlier: same req 200→403 post-probe-spree).
Fallback was built for ALBUMS (with-tracks→plain) per user's choice 2026-09-21 option 1; it does NOT and
SHOULD NOT cover playlist shares (no public-side equivalent). Available fixes are non-code: owning token in
.env, or IP cool-down. No code change. Nothing committed (rule 5 ✓). Plan/decision recorded (rule 1/2 ✓).
PLAN 2026-09-21 (rule 1): user confirms "opened playlist 4f7b10fe in logged-in Chrome = 200" => ownership of
that tab-account is proven by the WAF itself. Branch A (token in .env == that account): tsx start, verify
/healthz yandex_configured:true, POST /migrate mode=playlist source=<4f7b10fe kz share> -> expect done+batch.
Branch B (token != that account): run scripts/get_yandex_token.mjs to mint OAuth for the playlist-owning
account, put token in .env (manual secret step by ME only as instructed; NO write of token value to any file
that is committed), restart, re-probe. On 403 again in either branch after OWNING token: that is WAF
IP-cool-down (needs minutes-host) — recorder note to wait/try alternate host; no code action (rule 8 no-write).
Server stays DOWN until user consents to start (rule 5/kill-history ✓).
PROGRESS 2026-09-21 (rule 2): User reports they OPENED the share link in their own logged-in Chrome and it
renders (200). Honest framing I gave them: that proves the OWNING ACCOUNT's session works, but the migrator
runs on a token+host-IP, not on browser cookies — an app cannot borrow a Chrome session without exporting a
live credential, which I won't do (AGENTS auth boundary). The "another way" is a token minted from that
same logged-in account via scripts/get_yandex_token.mjs -> .env -> restart, OR (if token == that account
already) simply restart after cool-down. Server stays DOWN until user consents (they killed it; no
resurrection unasked — rule 5 both ways). Nothing committed anywhere. ✓
PLAN 2026-09-21 (rule 1, user said "go"): run scripts/get_yandex_token.mjs; capture device-code URL; print it
for user to open in their OWN logged-in Chrome (the account that owns 4f7b10fe...). NO password ever transits
my processes (device flow = user clicks allow in THEIR tab). Output token goes to user's .env by their own
paste/edit (rule 5 — I never write the token, never commit). Server stays DOWN until token verified via
healthz live probe WITH user consent to bring server up. Nothing committed.
