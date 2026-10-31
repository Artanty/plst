/**
 * Extension log: a ring buffer in chrome.storage.local plus a console mirror.
 *
 * Why this exists: the popup is a one-shot surface. It closes the moment you click away, and its
 * `msg` line only ever holds the latest state — so a scan that silently found nothing left no
 * trace at all, and "it did nothing" was indistinguishable from "it worked". This keeps the last
 * MAX entries across popup opens so a bug report can be answered with a real trace.
 *
 * Storage is best-effort: if chrome.storage is missing or throws (private windows, quota, a
 * content script context), everything still works in memory for the life of the page. Never let
 * logging throw into a caller.
 */
(() => {
  const MAX = 300;
  const KEY = "plst.log";
  const LEGACY_KEY = "yaum.log";
  // Entries predate the `shipped` flag; treat those as unsent so nothing is silently lost.
  const isUnshipped = (e) => !e || e.shipped !== true;
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  let mem = [];
  let storage = null;
  try {
    // MV3: chrome.storage is promise-based. Guarded because chrome can be undefined here.
    storage = globalThis.chrome?.storage?.local ?? null;
  } catch {
    storage = null;
  }

  const now = () => new Date().toISOString().slice(11, 23);

  const readStored = async () => {
    if (!storage) return;
    try {
      const got = await storage.get(KEY);
      const rows = got?.[KEY];
      if (Array.isArray(rows) && rows.length) {
        mem = rows.slice(-MAX);
        return;
      }
      // The buffer key was renamed with the app (yaum.log -> plst.log). Adopt the old buffer rather
      // than starting empty, otherwise the rename silently discards up to 300 pending entries that
      // have not been shipped to the backend yet.
      const legacy = await storage.get(LEGACY_KEY);
      const oldRows = legacy?.[LEGACY_KEY];
      if (Array.isArray(oldRows) && oldRows.length) mem = oldRows.slice(-MAX);
    } catch {
      /* keep whatever is in memory */
    }
  };

  const writeStored = async () => {
    if (!storage) return;
    try {
      await storage.set({ [KEY]: mem });
    } catch {
      /* a full or unavailable quota must never break the feature being logged */
    }
  };

  // Serialize writes so two rapid entries cannot land out of order, and coalesce so a 1.5s-per-step
  // walk does not turn into one storage write per step.
  let queued = Promise.resolve();
  const persist = () => {
    queued = queued.then(writeStored).catch(() => {});
    return queued;
  };

  const push = (level, scope, msg, data) => {
    // `t` is time-of-day, which is what a human reading the panel wants. `ts` is the full ISO
    // instant, and it has to be stored rather than derived later: entries now survive across days,
    // so time-of-day alone makes yesterday 12:00 and today 12:00 indistinguishable — and it is
    // what gets shipped to the backend, where ordering is the whole point.
    const entry = { t: now(), ts: new Date().toISOString(), level, scope, msg };
    if (data !== undefined) {
      try {
        entry.data = data;
      } catch {
        entry.data = '[unserializable]';
      }
    }
    mem.push(entry);
    if (mem.length > MAX) mem.splice(0, mem.length - MAX);

    const line = `${entry.t} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const extra = entry.data === undefined ? '' : ` ${safeJson(entry.data)}`;
    try {
      if (level === "error") console.error(line + extra, entry.data?.stack ?? "");
      else if (level === "warn") console.warn(line + extra);
      else console.log(line + extra);
    } catch {
      /* console can be unavailable in odd contexts */
    }
    persist();
    return entry;
  };

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }

  // Only entries at or above the threshold are kept. Default 'info' keeps the walk readable
  // without filling the buffer with per-scroll DOM chatter.
  // localStorage access THROWS (DOMException) on opaque origins such as about:blank and sandboxed
  // frames, so it is guarded — a log call must never be the thing that breaks the page.
  const threshold = () => {
    let want = "info";
try {
        want = (globalThis.localStorage?.getItem("plst.logLevel")
          // renamed with the app; honour the old value so a saved "debug" preference survives
          ?? globalThis.localStorage?.getItem("yaum.logLevel") ?? "info").toLowerCase();
      } catch {
      /* opaque origin: fall through to the default */
    }
    return LEVELS[want] ?? LEVELS.info;
  };

  const plstLog = {
    LEVELS,
    /** Load persisted entries. Call once at startup; safe to call twice. */
    async init() {
      await readStored();
      return mem;
    },
    debug: (scope, msg, data) =>
      LEVELS.debug >= threshold() ? push("debug", scope, msg, data) : null,
    info: (scope, msg, data) => (LEVELS.info >= threshold() ? push("info", scope, msg, data) : null),
    warn: (scope, msg, data) => push("warn", scope, msg, data),
    error: (scope, msg, data) => {
      // Normalize an Error into {name, message, stack} so it survives JSON round-tripping.
      let payload = data;
      if (data instanceof Error) {
        payload = { name: data.name, message: data.message, stack: data.stack };
      }
      return push("error", scope, msg, payload);
    },
    /** Current buffer, oldest first. */
    entries: () => mem.slice(),
    /** Entries not yet accepted by the backend. ship.js uses this; also the manual-upload path. */
    pending: () => mem.filter(isUnshipped),
    /** Mark entries as delivered, so the next batch does not resend them. */
    markShipped: (entries) => {
      for (const e of entries) if (e) e.shipped = true;
      persist();
      return entries.length;
    },
    /** Human-readable dump for the "copy logs" button and for pasting into a bug report. */
    text() {
      return mem
        .map((e) => {
          const d = e.data === undefined ? "" : ` ${safeJson(e.data)}`;
          return `${e.t} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}${d}`;
        })
        .join("\n");
    },
    clear() {
      mem = [];
      persist();
    },
    /** Await the pending write — tests and the copy button use this to avoid a race. */
    flush: () => queued,
  };

  globalThis.plstLog = plstLog;
  if (typeof module !== "undefined" && module.exports) module.exports = plstLog;
})();
