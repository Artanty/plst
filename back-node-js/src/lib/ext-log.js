/**
 * logging feature — extension log ingestion (js-node implementation).
 *
 * Contract: back/spec/logging.md (extension-log ingestion section). Vendored by consumers as
 * ext-log.js next to logger.js — the relative import below matches BOTH the feat ns dir and
 * the vendored location, because the sync copies logger.js (not index.js).
 */
import { Logger } from './logger.js';

export const EXT_LOG_FILE = 'ext.log';

export const extLogger = new Logger({
  filename: EXT_LOG_FILE,
  errorFilename: EXT_LOG_FILE,
  console: false,
});

/** Server-side levels. The extension's `debug` is folded into `log` — there is no debug channel. */
const LEVEL_MAP = {
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

const str = (value, max) => {
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
 * Turn an untrusted body into entries that are safe to append. Public endpoint, sender assumed
 * sloppy or hostile: everything bad is counted and dropped, never thrown — one bad entry must
 * not cost the remaining 199. Oversized batches keep the NEWEST entries (extension ships
 * oldest-first; the explaining entries are at the end).
 */
export function normalizeExtEntries(raw) {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0, capped: false };

  const out = [];
  let dropped = 0;

  const batch =
    raw.length > MAX_ENTRIES_PER_REQUEST ? raw.slice(raw.length - MAX_ENTRIES_PER_REQUEST) : raw;

  for (const candidate of batch) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      dropped += 1;
      continue;
    }
    const e = candidate;
    const msg = str(e.msg, MAX_MSG);
    if (!msg) {
      dropped += 1;
      continue;
    }
    const entry = {
      // Missing/unparseable ts becomes now rather than dropped: batch order is already right,
      // and losing a real error message over a bad date is worse.
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
 * Append a normalized batch and wait for it to be on disk — the flush is the point: the client
 * is told "stored", and a GET immediately afterwards must see the entries (the SIGTERM lesson,
 * request-shaped). The client stack rides in data as `extStack`, deliberately NOT as `stack`:
 * Logger would treat a top-level stack as an Error and discard the whole payload.
 */
export async function ingestExtLogs(normalized, ctx) {
  for (const e of normalized.entries) {
    const data = {
      extensionId: ctx.extensionId,
      scope: e.scope,
      // Client clock: arrival stamps would collide across browsers and lose true ordering.
      extTs: e.ts,
    };
    if (ctx.userId !== null) data.userId = ctx.userId;
    if (e.data !== undefined) data.ext = e.data;
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
export async function readExtLogs(opts = {}) {
  const entries = await extLogger.readLogFile(EXT_LOG_FILE);
  if (opts.last && opts.last > 0) return entries.slice(-opts.last);
  return entries;
}
