/**
 * Logger service with file rotation.
 *
 * Copy-friendly: depends only on Node built-ins. Drop this file into any project
 * and it works. Config is constructor options or env vars:
 *
 *   LOG_DIR        (default: <cwd>/logs)
 *   LOG_MAX_BYTES  (default: 1_000_000  — rotate a file once it exceeds this size)
 *   LOG_MAX_FILES  (default: 5          — keep this many rotated files)
 *   LOG_DISABLED   ('true' to turn off file writing)
 *   LOG_CONSOLE    ('off' to stop mirroring entries to the console; default: mirror)
 *   LOG_SKIP_POLL  ('off' to log every request; default: drop high-frequency read-only polls)
 *
 * Files:
 *   <LOG_DIR>/app.log       — log + warn entries
 *   <LOG_DIR>/error.log     — error entries
 *
 * Console mirror: every entry is also printed as one compact line
 * (`HH:MM:SS.mmm LEVEL fn msg {json data}`), because a dev run that writes only to a file looks
 * completely silent and "silent" reads as "nothing happened".
 *
 * Poll suppression: the Angular shell polls /me and /notifications on a timer, which drowns the
 * log in noise. Those URLs are dropped from the request log, but every drop is counted and the
 * total is logged once at startup, so a quiet log can never be mistaken for an idle server.
 *
 * Rotation: when a file exceeds LOG_MAX_BYTES it is renamed to <name>.1, the
 * previous .1 becomes .2, ..., and <name>.N is removed. Rotation happens on
 * write and is serialized through an internal queue, so concurrent appends
 * never interleave with a rename.
 *
 * Notes for free Render/Vercel tiers:
 *   - Render free: the project dir is writable, but the disk is ephemeral —
 *     logs survive for the life of a service but are lost on redeploy/restart.
 *   - Vercel serverless: only /tmp is writable and it is per-invocation.
 *     Set LOG_DIR=/tmp if you must log there; expect logs to be non-persistent.
 *   - Keep LOG_MAX_BYTES small so a busy backend can't blow up the disk.
 *
 * Entry format (one JSON object per line):
 *   { "ts": "<ISO datetime>", "level": "log|warn|error", "fn": "<caller fn>",
 *     "msg": "<message>", "stack": "<error stack, errors only>", "data": {...} }
 */
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'log' | 'warn' | 'error';
export type LogType = 'app' | 'error' | 'all';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  fn: string;
  msg: string;
  stack?: string;
  data?: unknown;
}

export interface LoggerOptions {
  dir?: string;
  filename?: string;
  errorFilename?: string;
  maxBytes?: number;
  maxFiles?: number;
  enabled?: boolean;
  /** mirror entries to the console as well as the file (default true, LOG_CONSOLE=off to disable) */
  console?: boolean;
}

export interface GetLogsOptions {
  /** inclusive start of the range */
  from?: Date;
  /** inclusive end of the range */
  to?: Date;
  /** return only the N most recent matching entries */
  last?: number;
  /** 'app' | 'error' | 'all' (default 'all') */
  type?: LogType;
  /** mask values of known-sensitive keys before returning */
  hideSensitive?: boolean;
  /** read this process's in-memory ring instead of the log files */
  memory?: boolean;
}

const SENSITIVE_KEY_RE =
  /\b(password|passwd|pass|pwd|token|secret|authorization|auth|cookie|captcha|otp|credit|card|email_pass|api[-_]?key|apikey|x-api-key|pat|bearer|private_key)\b/i;

const LOGGER_PATH = fileURLToPath(import.meta.url);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key.trim());
}

/**
 * Deep-masks values of sensitive keys (recursive, circular-safe). Request
 * params/headers are run through this before being stored so secrets never
 * hit the log files; the getter re-applies it when hideSensitive=true.
 */
export function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '***REDACTED***' : sanitize(val, seen);
  }
  return out;
}

export class Logger {
  private readonly dir: string;
  private readonly appFile: string;
  private readonly errorFile: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly enabled: boolean;
  private readonly toConsole: boolean;
  private queued: Promise<void> = Promise.resolve();

  /** Entries held in memory so a reader never has to hit the disk. */
  private readonly recent: LogEntry[] = [];
  private static readonly RECENT_MAX = 500;

  constructor(opts: LoggerOptions = {}) {
    this.dir = opts.dir ?? process.env.LOG_DIR ?? join(process.cwd(), 'logs');
    this.appFile = join(this.dir, opts.filename ?? 'app.log');
    this.errorFile = join(this.dir, opts.errorFilename ?? 'error.log');
    this.maxBytes = opts.maxBytes ?? (Number(process.env.LOG_MAX_BYTES) || 1_000_000);
    this.maxFiles = opts.maxFiles ?? (Number(process.env.LOG_MAX_FILES) || 5);
    this.enabled = opts.enabled ?? process.env.LOG_DISABLED !== 'true';
    this.toConsole = opts.console ?? process.env.LOG_CONSOLE !== 'off';
    mkdir(this.dir, { recursive: true }).catch((err) =>
      console.error('[logger] cannot create log dir:', err)
    );
  }

  /**
   * One compact line for the terminal. Deliberately NOT the raw JSON: the file has that, and a
   * human reading a dev server wants `scan imported 2 new` at a glance, with data beside it only
   * when there is data.
   */
  private print(entry: LogEntry): void {
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

  /**
   * Serialized append: all writes (and rotations) run one after another so a
   * rename never races with an in-flight appendFile.
   */
  private async enqueue(task: () => Promise<void>): Promise<void> {
    this.queued = this.queued.then(task).catch((err) => console.error('[logger] write failed:', err));
    await this.queued;
  }

  private async rotateIfNeeded(file: string): Promise<void> {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return; // file does not exist yet
    }
    if (size < this.maxBytes) return;

    const oldest = `${file}.${this.maxFiles}`;
    await rm(oldest, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      if (existsSync(src)) await rename(src, `${file}.${i + 1}`);
    }
    await rename(file, `${file}.1`);
  }

  private async emit(entry: LogEntry): Promise<void> {
    // The console mirror and the in-memory ring are independent of the file: LOG_DISABLED turns
    // off file writing, and that must not also blind a dev run or the HTTP log endpoint below.
    this.recent.push(entry);
    if (this.recent.length > Logger.RECENT_MAX) this.recent.splice(0, this.recent.length - Logger.RECENT_MAX);
    if (this.toConsole) this.print(entry);
    if (!this.enabled) return;
    const line = JSON.stringify(entry);
    const file = entry.level === 'error' ? this.errorFile : this.appFile;
    await this.enqueue(async () => {
      await this.rotateIfNeeded(file);
      await appendFile(file, `${line}\n`, 'utf8');
    });
  }

  private build(level: LogLevel, msg: string, data?: unknown, err?: unknown, fn?: string): LogEntry {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      fn: fn || this.captureCaller(),
      msg,
    };
    if (data !== undefined) entry.data = sanitize(data);
    if (err != null) {
      entry.stack =
        err instanceof Error
          ? err.stack || `${err.name}: ${err.message}`
          : String(err);
    }
    return entry;
  }

  /** First non-logger frame on the stack -> function name or file:line. */
  private captureCaller(): string {
    const stack = new Error().stack || '';
    for (const line of stack.split('\n')) {
      if (!line.trim().startsWith('at ')) continue;
      if (line.includes(LOGGER_PATH) || line.includes('/core/logger.')) continue;

      // V8 frames:
      //   at fnName (path:line:col)          - named
      //   at async fnName (path:line:col)    - named async
      //   at path:line:col                   - anonymous (no callable name)
      const named = line.match(/at\s+(?:async\s+)?([^\s(]+)\s+\((.+):(\d+):\d+\)/);
      if (named) {
        return named[1];
      }
      const anonym = line.match(/at\s+(?:async\s+)?(.+):(\d+):\d+\)?$/);
      if (anonym) {
        const f = anonym[1].split('/').pop() || anonym[1];
        return `${f}:${anonym[2]}`;
      }
    }
    return 'unknown';
  }

  log(msg: string, data?: unknown, fn?: string): void {
    void this.emit(this.build('log', msg, data, undefined, fn));
  }

  warn(msg: string, data?: unknown, fn?: string): void {
    void this.emit(this.build('warn', msg, data, undefined, fn));
  }

  /**
   * errOrData: pass an Error (stack is captured) or arbitrary data.
   * If it is an error-like object with a stack it is treated as an Error.
   */
  error(msg: string, errOrData?: unknown, fn?: string): void {
    const isErr =
      errOrData instanceof Error ||
      (!!errOrData && typeof errOrData === 'object' && 'stack' in errOrData);
    void this.emit(this.build('error', msg, isErr ? undefined : errOrData, isErr ? errOrData : undefined, fn));
  }

  async flush(): Promise<void> {
    await this.queued;
  }

  private async readFileInto(file: string, out: LogEntry[]): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as LogEntry);
      } catch {
        // skip malformed lines
      }
    }
  }

  private async readFiles(type: LogType): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    const wantsApp = type === 'all' || type === 'app';
    const wantsError = type === 'all' || type === 'error';

    if (wantsApp) {
      for (let i = this.maxFiles; i >= 1; i--) {
        await this.readFileInto(`${this.appFile}.${i}`, entries);
      }
      await this.readFileInto(this.appFile, entries);
    }
    if (wantsError) {
      for (let i = this.maxFiles; i >= 1; i--) {
        await this.readFileInto(`${this.errorFile}.${i}`, entries);
      }
      await this.readFileInto(this.errorFile, entries);
    }
    return entries;
  }

  /**
   * Read the parsed entries of any existing log file inside LOG_DIR
   * (e.g. 'app.strat.log'). Malformed lines are skipped.
   */
  async readLogFile(filename: string): Promise<LogEntry[]> {
    await this.flush();
    const entries: LogEntry[] = [];
    await this.readFileInto(join(this.dir, filename), entries);
    return entries;
  }

  /**
   * Getter for logs.
   *   from/to -> timerange (inclusive)
   *   last    -> only the N most recent matching entries
   *   type    -> 'app' | 'error' | 'all'
   *   hideSensitive -> mask sensitive keys in `data` before returning
   *   memory  -> read the in-memory ring instead of the files. The ring only holds this process's
   *              entries, so it is the right choice for "what just happened"; the files are the
   *              right choice for history across restarts.
   */
  async getLogs(opts: GetLogsOptions = {}): Promise<LogEntry[]> {
    await this.flush();
    let entries = opts.memory ? [...this.recent] : await this.readFiles(opts.type ?? 'all');

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