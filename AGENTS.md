# AGENTS.md

## Working agreement

1. **Before any code action** — write the plan to `DECISIONS.md`.
2. **After any code action** — write the progress/result to `DECISIONS.md`.
3. **On session start** — read `DECISIONS.md` first and keep it in mind throughout.
4. **When `DECISIONS.md` gets too big** — tell the user (explicitly flag it) so it can be trimmed/archived.
   At ~250 lines, move everything except the current thread into `DECISIONS-archive.md` (done once on
   2026-09-29: 455 -> 115 lines) and leave a one-line pointer in `DECISIONS.md`.
5. **Never commit unless the user explicitly asks** — do the work, leave changes uncommitted/staged, and stop.
6. **Commit messages are a plain imperative subject** — never append `-d` or `-d;` (nor any other
   suffix token). Just the sentence describing the change.

## Bug reports: read the logs FIRST

When the user reports a bug ("it doesn't work", "nothing happened", "X is empty"), **read the logs
before forming any theory.** Do not start theorising, and do not propose a fix, until you have
looked. Both halves log on purpose, precisely so this is possible.

```bash
# backend — most recent lines, and the errors on their own
cd back && npm run logs                  # follow both files, formatted (Ctrl-C to stop)
cd back && npm run logs -- --last 200    # more history
cd back && npm run logs -- --errors      # only error.log
cd back && npm run logs -- --ext         # only ext.log (what the extension shipped)
tail -40 back/logs/app.log
tail -20 back/logs/error.log
# or over HTTP, no shell access needed:
curl -s "http://127.0.0.1:8000/api/library/logs?last=60"
curl -s "http://127.0.0.1:8000/api/library/logs?last=60&type=error"

# extension — the popup shows it under "diagnostics log"; there is also a "Copy logs" button,
# and ext/logs.html renders the same buffer. Ask the user to paste it if it is not open.
```

The extension uploads its log to the backend, so the same trace is readable without the browser:

```bash
curl -s "http://127.0.0.1:8000/api/library/ext-logs?last=60"
curl -s "http://127.0.0.1:8000/api/library/ext-logs?last=60&level=error"
curl -s "http://127.0.0.1:8000/api/library/ext-logs?last=60&extensionId=<id>"   # id in the boot line
```

They land in `logs/ext.log` (not `app.log` — extension chatter would bury the server's own trace),
and each upload also writes one `ext logs ingested {received, stored, dropped, …}` line into
`app.log`. So **if that line is missing, the extension's logging never arrived**, which is a
different problem from the extension having nothing to log.

Rules that follow from this:

- A quiet log is not proof nothing happened. `GET /api/library/logs` returns `requestLogging`
  (`skippedPolls` / `loggedRequests`) precisely so suppressed poll traffic can be told apart from
  an idle server.
- Quote the actual log line in your reply. If the log contradicts your first theory, say so and
  correct it — a theory that was never checked is worse than no theory.
- When adding behaviour, add a log line with it, and prefer a message that names the cause
  ("scan rejected: all rows missing a title") over one that only restates the outcome.
- A line logged right before the process exits only counts if it is **flushed**. `logger.log()` queues
  an async append, so anything written during shutdown must `await logger.flush()` — otherwise it
  reaches the terminal and not the file, which is the copy that gets read next time. This actually
  happened: the SIGTERM poll report was missing from `app.log`. `reportSkipCounters` now awaits it.
- Don't trust the extension log to exist because the code calls it. `chrome.storage.*` needs the
  `"storage"` manifest permission, and the MV3 CSP (`script-src 'self'`) refuses inline `<script>`;
  without either one the feature is silently inert rather than erroring.

Why this rule exists: the "scanned 2 songs, nothing in the database" report had no trace from the
extension at all, and the backend had nothing about scans. Guessing from an empty database
produced a **false CORS theory** that had to be walked back. Logs first would have answered it in
seconds.

