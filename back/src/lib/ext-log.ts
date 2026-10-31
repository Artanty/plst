/**
 * The extension's log, as a server-side stream.
 *
 * A second Logger instance pointed at logs/ext.log. Deliberately its own file and not app.log:
 * extension chatter is high-volume and low-signal next to the server's own trace, so mixing them
 * would bury the very lines a bug report is answered from. Sharing the Logger class means
 * rotation, sensitive-key masking and reading all behave exactly as they do for app.log.
 *
 * Both filenames are ext.log on purpose: an error arriving from the extension belongs in the same
 * filterable stream as its neighbours, not split into a second file nobody opens.
 *
 * Console mirroring is OFF here. A 200-entry batch would print 200 lines into the dev terminal,
 * which is the noise the separate file exists to avoid; the one summary line per request that goes
 * to app.log is the terminal's share of the story.
 */
import { Logger } from './logger.js';

export const EXT_LOG_FILE = 'ext.log';

export const extLogger = new Logger({
  filename: EXT_LOG_FILE,
  errorFilename: EXT_LOG_FILE,
  console: false,
});

/** Server-side levels. The extension's `debug` is folded into `log` — there is no debug channel. */
const LEVEL_MAP: Record<string, 'log' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'log',
  log: 'log',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
};

export const MAX_ENTRIES_PER_REQUEST = 200;
const MAX_MSG = 500;
const MAX_SCOPE = 60;

/** One entry as received from an extension. */
export interface ExtLogEntry {
  ts?: unknown;
  level?: unknown;
  scope?: unknown;
  msg?: unknown;
  stack?: unknown;
  data?: unknown;
}

export interface ExtLogIngest {
  extensionId?: string | null;
  userId?: number | null;
  entries: unknown;
}

/** An entry after normalization: strings are bounded, level is one we can write. */
interface NormalizedEntry {
  ts: string;
  level: 'log' | 'warn' | 'error';
  scope: string;
  msg: string;
  stack?: string;
  data?: unknown;
}

export interface NormalizeResult {
  entries: NormalizedEntry[];
  dropped: number;
  capped: boolean;
}

const str = (value: unknown, max: number): string => {
  if (typeof value === 'string') return value.slice(0, max);
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, max);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value).slice(0, max);
};

/**
 * Turn an untrusted body into entries that are safe to append.
 *
 * This is a public endpoint with no auth, so it assumes the sender is sloppy or hostile: a batch
 * may be empty, not an array, contain strings instead of objects, or be a megabyte of junk. Every
 * such case is counted and dropped rather than throwing — one bad entry must not cost the
 * remaining 199, and a client must always get a number back describing what happened.
 */
export function normalizeExtEntries(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0, capped: false };

  const out: NormalizedEntry[] = [];
  let dropped = 0;

  // Keep the NEWEST, not the first N: the extension ships oldest-first and the entries that explain
  // a failure are the last ones written. A truncated trace is most useful at its end.
  const batch = raw.length > MAX_ENTRIES_PER_REQUEST ? raw.slice(raw.length - MAX_ENTRIES_PER_REQUEST) : raw;

  for (const candidate of batch) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      dropped += 1;
      continue;
    }
    const e = candidate as ExtLogEntry;
    const msg = str(e.msg, MAX_MSG);
    // An entry with no message is a bug or a probe; it says nothing and would only add a line.
    if (!msg) {
      dropped += 1;
      continue;
    }
    const entry: NormalizedEntry = {
      // A missing or unparseable timestamp becomes now rather than being dropped: the ordering of
      // the batch is already correct, and losing a real error message over a bad date is worse.
      ts: Number.isFinite(Date.parse(str(e.ts, 40)))
        ? new Date(str(e.ts, 40)).toISOString()
        : new Date().toISOString(),
      level: LEVEL_MAP[str(e.level, 10).toLowerCase()] ?? 'log',
      scope: str(e.scope, MAX_SCOPE) || 'ext',
      msg,
    };
    const stack = str(e.stack, 4000);
    if (stack) entry.stack = stack;
    if (e.data !== undefined) entry.data = e.data;
    out.push(entry);
  }

  return { entries: out, dropped, capped: raw.length > MAX_ENTRIES_PER_REQUEST };
}

/**
 * Append a normalized batch and wait for it to be on disk.
 *
 * The flush is the point: the client is told "stored", and a GET immediately afterwards must be
 * able to see the entries. That is the same trap that made the SIGTERM report vanish — an async
 * append racing an exit. Here the caller stays alive, but not awaiting would still make the
 * response lie.
 */
export async function ingestExtLogs(
  normalized: NormalizeResult,
  ctx: { extensionId: string | null; userId: number | null }
): Promise<void> {
  for (const e of normalized.entries) {
    const data: Record<string, unknown> = {
      extensionId: ctx.extensionId,
      scope: e.scope,
      // The client clock, because the Logger stamps its own arrival time. Without it, entries from
      // two browsers all claim the same second and true ordering is unrecoverable.
      extTs: e.ts,
    };
    if (ctx.userId !== null) data.userId = ctx.userId;
    if (e.data !== undefined) data.ext = e.data;
    // The stack rides inside data as `extStack`, deliberately NOT as a field named `stack`: Logger
    // treats a top-level `stack` as an Error and then discards the whole payload, and a separate
    // log line would vanish from a level=error filter — i.e. from exactly the query a crash needs.
    if (e.stack) data.extStack = e.stack;
    // fn keeps the origin unambiguous next to a server line with the same wording.
    const fn = `ext:${e.scope}`;
    if (e.level === 'error') extLogger.error(e.msg, data, fn);
    else if (e.level === 'warn') extLogger.warn(e.msg, data, fn);
    else extLogger.log(e.msg, data, fn);
  }
  await extLogger.flush();
}

/** Read the extension stream back, newest last, with the same masking the file getter applies. */
export async function readExtLogs(opts: { last?: number } = {}): Promise<Awaited<ReturnType<typeof extLogger.readLogFile>>> {
  const entries = await extLogger.readLogFile(EXT_LOG_FILE);
  if (opts.last && opts.last > 0) return entries.slice(-opts.last);
  return entries;
}