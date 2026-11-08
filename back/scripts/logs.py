#!/usr/bin/env python3
"""Tail the backend log files as compact, readable lines — port of scripts/logs.mjs.

  venv/bin/python scripts/logs.py                 # follow app.log + error.log, last 40 lines first
  venv/bin/python scripts/logs.py --last 200      # how much history to show before following
  venv/bin/python scripts/logs.py --errors        # only error.log ("the errors on their own")
  venv/bin/python scripts/logs.py --ext           # only ext.log (what the extension shipped)
  venv/bin/python scripts/logs.py --no-follow     # dump the tail and exit (scriptable)
  venv/bin/python scripts/logs.py --raw           # print the raw JSON lines instead

The files are written by lib/logger.py as one JSON object per line, which is great for machines and
awful for reading. This prints the same compact shape the logger mirrors to the console, so
`npm run logs` and a terminal running the server look alike.

No third-party dependencies, on purpose: it must keep working when the app itself is broken.

Note: an error entry is written ONLY to error.log (never to app.log), so following both files does
not duplicate anything.
"""
import json
import os
import signal
import sys
import time
from pathlib import Path

argv = sys.argv[1:]


def has(name):
    return name in argv


def value_of(name, dflt):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            return argv[i + 1]
    return dflt


if has("--help") or has("-h"):
    print("\n".join([
        "Usage: venv/bin/python scripts/logs.py -- [options]",
        "",
        "  --last N       lines of history to print before following (default 40, 0 to skip)",
        "  --errors       follow only error.log",
        "  --ext          follow ext.log — the extension log shipped from the popup",
        "  --no-follow    print the tail and exit",
        "  --raw          print raw JSON lines",
        "  --dir PATH     log directory (default: $LOG_DIR or ./logs)",
        "",
        "While the server is running, the same buffer is available over HTTP:",
        '  curl -s "http://127.0.0.1:8000/api/library/logs?last=60"',
        '  curl -s "http://127.0.0.1:8000/api/library/logs?last=60&type=error"',
    ]))
    sys.exit(0)

dir_ = Path(value_of("--dir", os.environ.get("LOG_DIR") or os.path.join(os.getcwd(), "logs")))
last = int(value_of("--last", "40") or 0)
follow = not has("--no-follow")
raw = has("--raw")
EXT_FILE = "ext.log"
if has("--ext"):
    files = [EXT_FILE]
elif has("--errors"):
    files = ["error.log"]
else:
    files = ["app.log", "error.log"]

offsets = {}


def print_line(line):
    try:
        entry = json.loads(line)
    except ValueError:
        print(line)  # malformed line: show it as-is rather than swallow it
        return
    if raw:
        print(line)
        return
    ts = str(entry.get("ts") or "")
    time_part = ts[11:23] if len(ts) >= 23 else ts
    level = str(entry.get("level") or "log").upper().ljust(5)
    out = f"{time_part} {level} {entry.get('msg') or ''}"
    fn = entry.get("fn")
    if fn and fn != "unknown":
        out += f"  ({fn})"
    if "data" in entry and entry["data"] is not None:
        try:
            out += f" {json.dumps(entry['data'])}"
        except (TypeError, ValueError):
            out += " [unserializable data]"
    print(out)
    if entry.get("stack"):
        print(entry["stack"])


def print_lines(text):
    for line in text.split("\n"):
        if line.strip():
            print_line(line)


def ts_of(line):
    """The entry's own timestamp, or '' for a malformed line (sorted last)."""
    try:
        return str(json.loads(line).get("ts") or "")
    except ValueError:
        return ""


def prime(file, n):
    """Read the whole file, remember where to continue from, and RETURN the lines rather than
    printing — the caller merges the files by timestamp first."""
    if not file.exists():
        offsets[file] = 0
        return []
    size = file.stat().st_size
    offsets[file] = size
    if n <= 0:
        return []
    # Everything, not a per-file slice: --last is applied after the merge, so it means "the newest N
    # overall" instead of "N from each file" (which would print 2N and could surface an older error
    # below a newer one).
    try:
        text = file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    return [(ts_of(line), line) for line in text.split("\n") if line.strip()]


def drain(file):
    """Read whatever was appended since the last check, line-aligned."""
    try:
        size = file.stat().st_size
    except OSError:
        return
    from_ = offsets.get(file, 0)
    if from_ > size:
        from_ = 0  # truncated or rotated out from under us: start over
    if from_ == size:
        offsets[file] = size
        return
    with open(file, "r", encoding="utf-8", errors="replace") as fh:
        fh.seek(from_)
        text = fh.read()
    nl = text.rfind("\n")
    if nl == -1:
        # a partial line, still being written: leave the offset before it
        return
    offsets[file] = from_ + len(text[: nl + 1].encode("utf-8"))
    print_lines(text[:nl])


existing = [f for f in files if (dir_ / f).exists()]
if len(existing) == len(files):
    print(f"tailing {' + '.join(str(dir_ / f) for f in files)} — Ctrl-C to stop\n")
else:
    # The point of this tool is to explain silence, so say which file is absent and why — a missing
    # error.log means "no errors yet", which is good news, not a missing log.
    if has("--errors"):
        print(f"no errors logged yet: {dir_ / 'error.log'} is created on the first error entry.")
    elif has("--ext"):
        # The usual reason this file is missing: the popup has not been opened since the endpoint
        # shipped, or shipping failed. Say so, rather than leaving it looking like a broken install.
        print(f"no extension logs yet: {dir_ / EXT_FILE} is created when the popup first uploads.")
        print('  open the popup, or press "Upload logs to server" in its diagnostics panel.')
    else:
        print(f"no log files in {dir_} yet — the server creates them on its first entry.")
        print(f"  LOG_DIR={dir_}  (start the server: cd back && venv/bin/python app.py)")
    if not follow:
        sys.exit(0)

# Merged by timestamp, not printed file by file. app.log and error.log are separate files, so a
# file-by-file dump put an error from last night AFTER today's lines — which reads as scrambled
# output rather than as history, and makes a quiet start look like it is hiding a failure.
primed = []
for f in files:
    primed.extend(prime(dir_ / f, last))
primed.sort(key=lambda pair: pair[0])
for _, line in (primed[-last:] if last > 0 else primed):
    print_line(line)


def stop(_signum, _frame):
    print("")
    sys.exit(0)


if follow:
    # Polling rather than inotify: it survives rotation and truncation without a re-attach dance,
    # and 250ms is far below anything a human reading a terminal will notice.
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while True:
        time.sleep(0.25)
        for f in files:
            drain(dir_ / f)
