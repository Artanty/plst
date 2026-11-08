/**
 * logging feature — Logger with file rotation (js-node implementation).
 *
 * Canonical home: this directory (see back/spec/logging.md for the contract).
 * Vendored by consumers (plst: back/scripts/sync-features.mjs → back/src/lib/logger.js).
 * Ported verbatim from plst's original back/src/lib/logger.ts — behavior frozen by the spec.
 *
 * Copy-friendly: depends only on Node built-ins. Config is constructor options or env vars:
 *   LOG_DIR        (default: <cwd>/logs)
 *   LOG_MAX_BYTES  (default: 1_000_000)   LOG_MAX_FILES (default: 5)
 *   LOG_DISABLED   ('true' → no file writing; console+ring stay alive)
 *   LOG_CONSOLE    ('off' → no console mirror)
 */
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENSITIVE_KEY_RE =
  /\b(password|passwd|pass|pwd|token|secret|authorization|auth|cookie|captcha|otp|credit|card|email_pass|api[-_]?key|apikey|x-api-key|pat|bearer|private_key)\b/i;

const LOGGER_PATH = fileURLToPath(import.meta.url);

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(key.trim());
}

/**
 * Deep-masks values of sensitive keys (recursive, circular-safe).
 */
export function sanitize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '***REDACTED***' : sanitize(val, seen);
  }
  return out;
}

export class Logger {
  #dir;
  #appFile;
  #errorFile;
  #maxBytes;
  #maxFiles;
  #enabled;
  #toConsole;
  #queued = Promise.resolve();
  #recent = [];
  static #RECENT_MAX = 500;

  constructor(opts = {}) {
    this.#dir = opts.dir ?? process.env.LOG_DIR ?? join(process.cwd(), 'logs');
    this.#appFile = join(this.#dir, opts.filename ?? 'app.log');
    this.#errorFile = join(this.#dir, opts.errorFilename ?? 'error.log');
    this.#maxBytes = opts.maxBytes ?? (Number(process.env.LOG_MAX_BYTES) || 1_000_000);
    this.#maxFiles = opts.maxFiles ?? (Number(process.env.LOG_MAX_FILES) || 5);
    this.#enabled = opts.enabled ?? process.env.LOG_DISABLED !== 'true';
    this.#toConsole = opts.console ?? process.env.LOG_CONSOLE !== 'off';
    mkdir(this.#dir, { recursive: true }).catch((err) =>
      console.error('[logger] cannot create log dir:', err),
    );
  }

  /** One compact line for the terminal (not the raw JSON — the file has that). */
  #print(entry) {
    const time = entry.ts.slice(11, 23);
    const level = entry.level.toUpperCase().padEnd(5);
    let line = `${time} ${level} ${entry.msg}`;
    if (entry.fn && entry.fn !== 'unknown') line += `  (${entry.fn})`;
    if (entry.data !== undefined) {
      try {
        line += ` ${JSON.stringify(entry.data)}`;
      } catch {
        line += ' [unserializable data]';
      }
    }
    if (entry.level === 'error') {
      console.error(line);
      if (entry.stack) console.error(entry.stack);
    } else if (entry.level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  /** Serialized append: writes and rotations run one after another. */
  async #enqueue(task) {
    this.#queued = this.#queued.then(task).catch((err) => console.error('[logger] write failed:', err));
    await this.#queued;
  }

  async #rotateIfNeeded(file) {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return; // file does not exist yet
    }
    if (size < this.#maxBytes) return;

    const oldest = `${file}.${this.#maxFiles}`;
    await rm(oldest, { force: true });
    for (let i = this.#maxFiles - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      if (existsSync(src)) await rename(src, `${file}.${i + 1}`);
    }
    await rename(file, `${file}.1`);
  }

  async #emit(entry) {
    // Console mirror and memory ring are independent of file writing (LOG_DISABLED must not
    // blind a dev run or the log-reader).
    this.#recent.push(entry);
    if (this.#recent.length > Logger.#RECENT_MAX) {
      this.#recent.splice(0, this.#recent.length - Logger.#RECENT_MAX);
    }
    if (this.#toConsole) this.#print(entry);
    if (!this.#enabled) return;
    const line = JSON.stringify(entry);
    const file = entry.level === 'error' ? this.#errorFile : this.#appFile;
    await this.#enqueue(async () => {
      await this.#rotateIfNeeded(file);
      await appendFile(file, `${line}\n`, 'utf8');
    });
  }

  #build(level, msg, data, err, fn) {
    const entry = { ts: new Date().toISOString(), level, fn: fn || this.#captureCaller(), msg };
    if (data !== undefined) entry.data = sanitize(data);
    if (err != null) {
      entry.stack = err instanceof Error ? err.stack || `${err.name}: ${err.message}` : String(err);
    }
    return entry;
  }

  /** First non-logger frame on the stack -> function name or file:line. */
  #captureCaller() {
    const stack = new Error().stack || '';
    for (const line of stack.split('\n')) {
      if (!line.trim().startsWith('at ')) continue;
      if (line.includes(LOGGER_PATH) || line.includes('/core/logger.')) continue;

      const named = line.match(/at\s+(?:async\s+)?([^\s(]+)\s+\((.+):(\d+):\d+\)/);
      if (named) return named[1];
      const anonym = line.match(/at\s+(?:async\s+)?(.+):(\d+):\d+\)?$/);
      if (anonym) {
        const f = anonym[1].split('/').pop() || anonym[1];
        return `${f}:${anonym[2]}`;
      }
    }
    return 'unknown';
  }

  log(msg, data, fn) {
    void this.#emit(this.#build('log', msg, data, undefined, fn));
  }

  warn(msg, data, fn) {
    void this.#emit(this.#build('warn', msg, data, undefined, fn));
  }

  /** errOrData: an Error (or error-like, has .stack) → stack captured; anything else → data. */
  error(msg, errOrData, fn) {
    const isErr =
      errOrData instanceof Error || (!!errOrData && typeof errOrData === 'object' && 'stack' in errOrData);
    void this.#emit(this.#build('error', msg, isErr ? undefined : errOrData, isErr ? errOrData : undefined, fn));
  }

  /** Await the write queue — MUST be called before process exit or pre-exit lines vanish. */
  async flush() {
    await this.#queued;
  }

  async #readFileInto(file, out) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        // skip malformed lines
      }
    }
  }

  async #readFiles(type) {
    const entries = [];
    const wantsApp = type === 'all' || type === 'app';
    const wantsError = type === 'all' || type === 'error';

    if (wantsApp) {
      for (let i = this.#maxFiles; i >= 1; i--) await this.#readFileInto(`${this.#appFile}.${i}`, entries);
      await this.#readFileInto(this.#appFile, entries);
    }
    if (wantsError) {
      for (let i = this.#maxFiles; i >= 1; i--) await this.#readFileInto(`${this.#errorFile}.${i}`, entries);
      await this.#readFileInto(this.#errorFile, entries);
    }
    return entries;
  }

  /** Parsed entries of any existing log file inside the log dir (e.g. 'ext.log'). */
  async readLogFile(filename) {
    await this.flush();
    const entries = [];
    await this.#readFileInto(join(this.#dir, filename), entries);
    return entries;
  }

  /**
   * from/to (inclusive) → timerange; last → N most recent; type 'app'|'error'|'all';
   * hideSensitive → re-mask data on read; memory → this process's ring, not the files.
   */
  async getLogs(opts = {}) {
    await this.flush();
    let entries = opts.memory ? [...this.#recent] : await this.#readFiles(opts.type ?? 'all');

    if (opts.from || opts.to) {
      const from = opts.from ? opts.from.getTime() : -Infinity;
      const to = opts.to ? opts.to.getTime() : Infinity;
      entries = entries.filter((e) => {
        const t = new Date(e.ts).getTime();
        return t >= from && t <= to;
      });
    }

    entries.sort((a, b) => a.ts.localeCompare(b.ts));

    if (opts.hideSensitive) {
      entries = entries.map((e) => (e.data !== undefined ? { ...e, data: sanitize(e.data) } : e));
    }

    if (typeof opts.last === 'number' && opts.last > 0) {
      return entries.slice(-opts.last);
    }
    return entries;
  }
}

/** Shared singleton for the app; create your own Logger() per project/file if needed. */
export const logger = new Logger();
