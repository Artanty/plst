/**
 * Ships the extension log to the backend (POST /api/library/ext-logs).
 *
 * Why: the buffer in log.js persists across popup closes but not across machines, profiles or
 * reboots, and it is not greppable. The backend already keeps rotated JSON logs and can be read
 * over HTTP, so pushing the trace there is what makes "the extension said nothing" a claim you can
 * check rather than take on trust.
 *
 * Deliberately a separate file loaded only in the popup, NOT inside log.js: log.js is also a
 * content script, and shipping from there would POST an identical batch once per frame.
 *
 * Designed around the failure mode a logging feature is most prone to — becoming the noise:
 *  - only unshipped entries are sent, and they are marked shipped only after the server accepts
 *  - one in-flight request at a time; extra calls are no-ops, not a queue of requests
 *  - backoff 5s → 15s → 60s → 5min, then it stops for good, so a backend that is down cannot turn
 *    into an endless stream of "shipping failed" entries (which would themselves be shipped)
 *  - its own diagnostics stay at debug level; only a change in backoff step is worth a warn
 *  - never throws into the caller, and never blocks the popup
 */
(() => {
  const ENDPOINT = "/api/library/ext-logs";
  const BATCH = 100;
  const MAX_ATTEMPTS = 6;
  const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
  const TIMEOUT_MS = 4_000;

  // The app was renamed mush/yaum -> plst, which included the storage keys. Read the new key
  // first, then the old one, so a browser that saved settings under the previous names keeps its
  // backend URL and user id instead of silently reverting to the defaults.
  const LEGACY_KEYS = { "plst.server": "mush.server", "plst.userId": "yaum.userId" };
  const readLocal = (key, dflt = null) => {
    let legacy = null;
    try {
      const hit = globalThis.localStorage?.getItem(key);
      if (hit !== null && hit !== undefined) return hit;
      legacy = globalThis.localStorage?.getItem(LEGACY_KEYS[key] ?? "") ?? null;
    } catch {
      return dflt; // opaque origin: localStorage throws
    }
    return legacy ?? dflt;
  };

  // Same defaults as popup.js. Read from storage rather than from the popup's inputs, because this
  // also runs on pagehide when the inputs may already be gone.
  const DEFAULT_SERVER = "https://evidence-qulg.onrender.com";
  const server = () => (readLocal("plst.server", "") || DEFAULT_SERVER).replace(/\/+$/, "");
  const userId = () => {
    const raw = readLocal("plst.userId", "");
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const extensionId = () => globalThis.chrome?.runtime?.id ?? null;

  let inFlight = null;
  let attempts = 0;
  let status = { state: "idle", at: null, sent: 0, error: null, attempts: 0 };

  const setStatus = (patch) => {
    status = { ...status, ...patch, at: new Date().toISOString() };
    return status;
  };

  /**
   * The wire shape: `t` is redundant once `ts` exists and `shipped` is a local flag, so neither is
   * sent. An Error was normalized by log.js into {name, message, stack}; the stack travels as the
   * entry's own field (which is where the backend reads it from) rather than staying buried in data.
   */
  const wire = (e) => {
    let stack;
    let data;
    if (e.data && typeof e.data === "object" && !Array.isArray(e.data)) {
      ({ stack, ...data } = e.data);
      if (!Object.keys(data).length) data = undefined; // it was only a stack
    } else {
      data = e.data;
    }
    return { ts: e.ts, level: e.level, scope: e.scope, msg: e.msg, stack, data };
  };

  /**
   * Send everything pending, oldest batch first, until the queue is empty.
   *
   * A loop rather than a recursive call after success: the recursive version re-entered while
   * `inFlight` still pointed at the promise it was running inside, so the second batch awaited
   * itself and the first upload never resolved at all.
   */
  async function drain() {
    let total = 0;
    for (;;) {
      const pending = globalThis.plstLog?.pending?.() ?? [];
      if (!pending.length) {
        return total
          ? setStatus({ state: "ok", sent: total, error: null, attempts: 0 })
          : setStatus({ state: "empty", error: null });
      }

      const batch = pending.slice(-BATCH);
      let stored;
      try {
        const res = await fetch(`${server()}${ENDPOINT}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            extensionId: extensionId(),
            userId: userId(),
            entries: batch.map(wire),
          }),
          // keepalive lets the request outlive the closing popup, which is the moment there is
          // usually something new worth delivering.
          keepalive: true,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`server replied ${res.status}`);
        const body = await res.json().catch(() => ({}));
        stored = typeof body.stored === "number" ? body.stored : batch.length;
        // Only now are they really delivered: an entry marked shipped on a failed request is gone.
        globalThis.plstLog.markShipped(batch);
        total += stored;
        attempts = 0;
      } catch (err) {
        attempts += 1;
        const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        const done = attempts >= MAX_ATTEMPTS;
        // debug, not warn: a warn here becomes an entry that must itself be shipped, which is how a
        // logging feature turns into the noise it was added to prevent. The popup shows the state.
        globalThis.plstLog?.debug?.(
          "ship",
          done ? `giving up after ${attempts} attempts` : "retrying later",
          { attempt: attempts, retryInMs: wait, error: String(err?.message ?? err) }
        );
        return setStatus({
          state: done ? "gave-up" : "retrying",
          error: String(err?.message ?? err),
          sent: total,
          attempts,
        });
      }

      // The server kept fewer than it was given (its own per-request cap). Retrying the remainder
      // immediately would just hit the cap again, so stop and report it instead of spinning.
      if (stored < batch.length) {
        return setStatus({ state: "ok", sent: total, error: null, attempts: 0, truncated: true });
      }
    }
  }

  async function ship(options = {}) {
    if (inFlight) return inFlight;
    const { force = false } = options;
    // Resumed backoff: stop bothering a backend that is down until someone asks again.
    if (attempts >= MAX_ATTEMPTS && !force) {
      return setStatus({ state: "gave-up", error: status.error, attempts });
    }
    // An explicit ask ("Upload logs", or the last-chance ship on close) gets a fresh attempt
    // budget. Without this the counter is already spent, so one manual click reported "gave up"
    // again even though it had just sent a request — the user fixed the server and was told nothing
    // had happened.
    if (force) attempts = 0;
    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  globalThis.plstShip = {
    ENDPOINT,
    /** Ship now (no-op if a request is already running). `force` ignores a spent backoff. */
    ship,
    /** Last outcome, for the popup's diagnostics panel. */
    status: () => ({ ...status }),
    /** Human-readable one-liner, so the popup does not re-derive the wording. */
    describe: () => {
      if (!status.at) return "not sent yet";
      const when = status.at.slice(11, 19);
      if (status.state === "ok") {
        const cut = status.truncated ? " (server kept fewer than were sent)" : "";
        return `✓ ${status.sent} entry(s) accepted by the server at ${when}${cut}`;
      }
      if (status.state === "empty") return "nothing new to send";
      if (status.state === "retrying") {
        return `⚠ send failed (attempt ${status.attempts}): ${status.error} — retrying later`;
      }
      if (status.state === "gave-up") return `⚠ gave up after ${status.attempts} attempts: ${status.error}`;
      return status.state;
    },
  };
})();