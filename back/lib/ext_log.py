"""logging feature — extension log ingestion (python implementation).

Contract: back/spec/logging.md (extension-log ingestion section). Vendored by consumers as
ext_log.py next to logger.py. Console mirroring is OFF for the ext stream (a 200-entry batch
must not print 200 terminal lines).
"""
import json

from .logger import Logger

EXT_LOG_FILE = "ext.log"

ext_logger = Logger(filename=EXT_LOG_FILE, error_filename=EXT_LOG_FILE, console=False)

# Server-side levels. The extension's `debug` is folded into `log` — there is no debug channel.
LEVEL_MAP = {
    "debug": "log",
    "info": "log",
    "log": "log",
    "warn": "warn",
    "warning": "warn",
    "error": "error",
}

MAX_ENTRIES_PER_REQUEST = 200
_MAX_MSG = 500
_MAX_SCOPE = 60
_MAX_TS = 40
_MAX_STACK = 4000


def _str(value, max_len: int) -> str:
    if isinstance(value, str):
        return value[:max_len]
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value)[:max_len]
        except (TypeError, ValueError):
            return "[unserializable]"
    return str(value)[:max_len]


def normalize_ext_entries(raw):
    """Turn an untrusted body into entries safe to append.

    Public endpoint, sender assumed sloppy or hostile: everything bad is counted and dropped,
    never thrown — one bad entry must not cost the remaining 199. Oversized batches keep the
    NEWEST entries (the extension ships oldest-first; the explaining entries are at the end).
    """
    if not isinstance(raw, list):
        return {"entries": [], "dropped": 0, "capped": False}

    out = []
    dropped = 0
    batch = raw[len(raw) - MAX_ENTRIES_PER_REQUEST:] if len(raw) > MAX_ENTRIES_PER_REQUEST else raw

    from datetime import datetime, timezone

    def now_iso():
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    for candidate in batch:
        if not isinstance(candidate, dict) or isinstance(candidate, list):
            dropped += 1
            continue
        msg = _str(candidate.get("msg"), _MAX_MSG)
        if not msg:
            dropped += 1
            continue
        ts_raw = _str(candidate.get("ts"), _MAX_TS)
        try:
            # Normalize to node's ISO form: millisecond precision, trailing Z.
            parsed = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            ts = parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"
        except ValueError:
            ts = now_iso()
        entry = {
            "ts": ts,
            "level": LEVEL_MAP.get(_str(candidate.get("level"), 10).lower(), "log"),
            "scope": _str(candidate.get("scope"), _MAX_SCOPE) or "ext",
            "msg": msg,
        }
        stack = _str(candidate.get("stack"), _MAX_STACK)
        if stack:
            entry["stack"] = stack
        if "data" in candidate and candidate["data"] is not None:
            entry["data"] = candidate["data"]
        out.append(entry)

    return {"entries": out, "dropped": dropped, "capped": len(raw) > MAX_ENTRIES_PER_REQUEST}


def ingest_ext_logs(normalized, ctx):
    """Append a normalized batch. Writes are synchronous under the logger lock — the response
    never lies about "stored" (the SIGTERM lesson, request-shaped).

    The client stack rides in data as `extStack`, deliberately NOT as a top-level stack field:
    the Logger would treat it as an error and discard the payload. `extTs` carries the CLIENT
    clock — arrival stamps would collide across browsers and lose true ordering.
    """
    user_id = ctx.get("userId")
    extension_id = ctx.get("extensionId")
    for e in normalized["entries"]:
        data = {
            "extensionId": extension_id,
            "scope": e["scope"],
            "extTs": e["ts"],
        }
        if user_id is not None:
            data["userId"] = user_id
        if "data" in e:
            data["ext"] = e["data"]
        if "stack" in e:
            data["extStack"] = e["stack"]
        fn = f"ext:{e['scope']}"
        if e["level"] == "error":
            ext_logger.error(e["msg"], data, fn)
        elif e["level"] == "warn":
            ext_logger.warn(e["msg"], data, fn)
        else:
            ext_logger.log(e["msg"], data, fn)
    ext_logger.flush()


def read_ext_logs(last=None):
    """Read the extension stream back, newest last."""
    entries = ext_logger.read_log_file(EXT_LOG_FILE)
    if last and last > 0:
        return entries[-last:]
    return entries
