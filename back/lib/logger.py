"""logging feature — Logger with file rotation (python implementation).

Contract: back/spec/logging.md (same file as the js-node build). Vendored by consumers
(plst: back/scripts/sync_features.py -> back/lib/logger.py). Entry format is byte-compatible
with the js-node logger: one JSON object per line
  {"ts": "<ISO>", "level": "log|warn|error", "fn": "<caller>", "msg": "...", "stack": "...", "data": {...}}
so log files written by either language are readable by both.

Config: constructor opts override env, env overrides defaults —
  LOG_DIR (default <cwd>/logs), LOG_MAX_BYTES (1_000_000), LOG_MAX_FILES (5),
  LOG_DISABLED=true (no file writes; console + ring stay alive), LOG_CONSOLE=off.
"""
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

SENSITIVE_KEY_RE = re.compile(
    r"\b(password|passwd|pass|pwd|token|secret|authorization|auth|cookie|captcha|otp|credit|card|"
    r"email_pass|api[-_]?key|apikey|x-api-key|pat|bearer|private_key)\b",
    re.IGNORECASE,
)

REDACTED = "***REDACTED***"
RECENT_MAX = 500


def _is_sensitive_key(key: str) -> bool:
    return bool(SENSITIVE_KEY_RE.search(key.strip()))


def sanitize(value, seen=None):
    """Deep-mask values of sensitive keys (recursive, circular-safe)."""
    if value is None or not isinstance(value, (dict, list)):
        return value
    seen = set() if seen is None else seen
    marker = id(value)
    if marker in seen:
        return "[Circular]"
    seen.add(marker)
    if isinstance(value, list):
        return [sanitize(item, seen) for item in value]
    return {
        key: REDACTED if _is_sensitive_key(key) else sanitize(val, seen)
        for key, val in value.items()
    }


class Logger:
    def __init__(self, dir=None, filename="app.log", error_filename="error.log",
                 max_bytes=None, max_files=None, enabled=None, console=None):
        self.dir = Path(dir or os.environ.get("LOG_DIR") or Path.cwd() / "logs")
        self.app_file = self.dir / filename
        self.error_file = self.dir / error_filename
        self.max_bytes = max_bytes if max_bytes is not None else int(os.environ.get("LOG_MAX_BYTES") or 1_000_000)
        self.max_files = max_files if max_files is not None else int(os.environ.get("LOG_MAX_FILES") or 5)
        self.enabled = (os.environ.get("LOG_DISABLED") != "true") if enabled is None else enabled
        self.to_console = (os.environ.get("LOG_CONSOLE") != "off") if console is None else console
        self._recent = []
        self._lock = threading.Lock()
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            print(f"[logger] cannot create log dir: {err}", file=sys.stderr)

    def _print(self, entry):
        """One compact line for the terminal (not the raw JSON — the file has that)."""
        time = entry["ts"][11:23]
        level = entry["level"].upper().ljust(5)
        line = f"{time} {level} {entry['msg']}"
        if entry.get("fn") and entry["fn"] != "unknown":
            line += f"  ({entry['fn']})"
        if "data" in entry:
            try:
                line += f" {json.dumps(entry['data'])}"
            except (TypeError, ValueError):
                line += " [unserializable data]"
        if entry["level"] == "error":
            print(line, file=sys.stderr)
            if entry.get("stack"):
                print(entry["stack"], file=sys.stderr)
        else:
            print(line)

    def _emit(self, entry):
        # Console mirror and memory ring are independent of file writing (LOG_DISABLED must
        # not blind a dev run or the log reader). Writes are serialized by the lock, so a
        # rename never races an append; flush() is therefore implicit — but kept as API.
        with self._lock:
            self._recent.append(entry)
            if len(self._recent) > RECENT_MAX:
                del self._recent[: len(self._recent) - RECENT_MAX]
        if self.to_console:
            self._print(entry)
        if not self.enabled:
            return
        file = self.error_file if entry["level"] == "error" else self.app_file
        with self._lock:
            self._rotate_if_needed(file)
            with open(file, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _rotate_if_needed(self, file: Path):
        if not file.exists() or file.stat().st_size < self.max_bytes:
            return
        oldest = Path(f"{file}.{self.max_files}")
        oldest.unlink(missing_ok=True)
        for i in range(self.max_files - 1, 0, -1):
            src = Path(f"{file}.{i}")
            if src.exists():
                src.rename(f"{file}.{i + 1}")
        file.rename(f"{file}.1")

    def _build(self, level, msg, data=None, err=None, fn=None):
        entry = {"ts": _now_iso(), "level": level, "fn": fn or self._capture_caller(), "msg": msg}
        if data is not None:
            entry["data"] = sanitize(data)
        if err is not None:
            import traceback

            entry["stack"] = (
                "".join(traceback.format_exception(type(err), err, err.__traceback__)).strip()
                if err.__traceback__
                else f"{type(err).__name__}: {err}"
            )
        return entry

    def _capture_caller(self) -> str:
        """First non-logger frame on the stack -> function name (python: `file.py:line:fn`)."""
        import inspect

        frame = inspect.currentframe()
        while frame is not None:
            name = frame.f_code.co_filename
            if name != __file__:
                base = os.path.basename(name)
                return frame.f_code.co_name or f"{base}:{frame.f_lineno}"
            frame = frame.f_back
        return "unknown"

    def log(self, msg, data=None, fn=None):
        self._emit(self._build("log", msg, data, None, fn))

    def warn(self, msg, data=None, fn=None):
        self._emit(self._build("warn", msg, data, None, fn))

    def error(self, msg, err_or_data=None, fn=None):
        """An Exception (or anything with __traceback__) -> stack captured; else stored as data."""
        is_err = isinstance(err_or_data, BaseException)
        self._emit(self._build("error", msg, None if is_err else err_or_data, err_or_data if is_err else None, fn))

    def flush(self):
        """Writes are synchronous under the lock; kept for API parity with the js-node build."""
        with self._lock:
            pass

    @staticmethod
    def _read_file_into(file: Path, out: list):
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            return
        for raw in text.split("\n"):
            if not raw.strip():
                continue
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError:
                pass  # skip malformed lines

    def _read_files(self, type_="all"):
        entries = []
        wants_app = type_ in ("all", "app")
        wants_error = type_ in ("all", "error")
        if wants_app:
            for i in range(self.max_files, 0, -1):
                self._read_file_into(Path(f"{self.app_file}.{i}"), entries)
            self._read_file_into(self.app_file, entries)
        if wants_error:
            for i in range(self.max_files, 0, -1):
                self._read_file_into(Path(f"{self.error_file}.{i}"), entries)
            self._read_file_into(self.error_file, entries)
        return entries

    def read_log_file(self, filename: str):
        """Parsed entries of any existing log file inside the log dir (e.g. 'ext.log')."""
        entries = []
        self._read_file_into(self.dir / filename, entries)
        return entries

    def get_logs(self, from_=None, to=None, last=None, type_="all", hide_sensitive=False, memory=False):
        """from_/to (inclusive datetimes) -> range; last -> N most recent; hide_sensitive re-masks."""
        entries = list(self._recent) if memory else self._read_files(type_)
        if from_ is not None or to is not None:
            from_ts = from_.timestamp() if from_ else float("-inf")
            to_ts = to.timestamp() if to else float("inf")
            entries = [e for e in entries if from_ts <= _parse_ts(e["ts"]) <= to_ts]
        entries.sort(key=lambda e: e["ts"])
        if hide_sensitive:
            entries = [{**e, "data": sanitize(e["data"])} if "data" in e else e for e in entries]
        if isinstance(last, int) and last > 0:
            return entries[-last:]
        return entries


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_ts(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


logger = Logger()
