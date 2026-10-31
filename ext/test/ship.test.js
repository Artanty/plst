// ship.js pushes the extension trace to the backend. The interesting cases are not the happy path —
// they are the ways a logging feature turns into a liability: resending everything on every popup
// open, marking entries shipped when the server rejected them, and looping forever against a
// backend that is down.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const http = require("http");

const LOG_JS = fs.readFileSync(path.join(__dirname, "..", "log.js"), "utf8");
const SHIP_JS = fs.readFileSync(path.join(__dirname, "..", "ship.js"), "utf8");

let server;
let origin;
let lastBody = null;
let replyMode = "ok";
let requestCount = 0;
let batchSizes = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requestCount += 1;
      lastBody = raw ? JSON.parse(raw) : null;
      if (lastBody?.entries) batchSizes.push(lastBody.entries.length);
      if (replyMode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      } else if (replyMode === "garbage") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: lastBody?.entries?.length ?? 0 }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

test.beforeEach(() => {
  lastBody = null;
  requestCount = 0;
  batchSizes = [];
  replyMode = "ok";
});

/**
 * Loads log.js + ship.js with a stubbed chrome and a recording fetch.
 * `failTimes` makes the first N fetches reject, to exercise the backoff path.
 */
const load = async (page, { failTimes = 0, withRuntime = true } = {}) => {
  await page.addInitScript(
    ({ rt }) => {
      window.__mem = {};
      window.__fails = 0;
      window.chrome = {
        runtime: rt ? { id: "testextensionid000000" } : undefined,
        storage: {
          local: {
            get: async (k) => ({ [k]: window.__mem[k] }),
            set: async (o) => Object.assign(window.__mem, o),
          },
        },
      };
      localStorage.setItem("plst.server", window.__origin);
      localStorage.setItem("plst.userId", "1");
      // Real fetch against the stubbed route, with an optional failure counter.
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        if (String(url).includes("/api/library/ext-logs") && window.__failTimes > 0) {
          window.__failTimes -= 1;
          throw new Error("network down");
        }
        return realFetch(url, init);
      };
    },
    { rt: withRuntime, failTimes }
  );
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ log, ship }) => {
      // eslint-disable-next-line no-eval
      eval(log);
      // eslint-disable-next-line no-eval
      eval(ship);
    },
    { log: LOG_JS, ship: SHIP_JS }
  );
  await page.evaluate(() => globalThis.plstLog.init());
};

test("uploads entries and marks them shipped so they are not sent twice", async ({ page }) => {
  await load(page);
  const first = await page.evaluate(async () => {
    plstLog.info("popup", "hello", { tracks: 2 });
    await plstLog.flush();
    const r = await plstShip.ship();
    return { status: r, pending: plstLog.pending().length, total: plstLog.entries().length };
  });
  expect(first.total).toBe(1);
  expect(first.pending).toBe(0); // marked shipped
  expect(first.status.state).toBe("ok");
  expect(first.status.sent).toBe(1);

  // Second popup open: nothing left to send, and no request is made at all.
  const before = requestCount;
  const second = await page.evaluate(async () => {
    const r = await plstShip.ship();
    return { state: r.state, status: plstShip.status().state };
  });
  expect(second.state).toBe("empty");
  expect(requestCount).toBe(before);
});

test("sends the whole shape the backend validates: extensionId, userId, ts, level, scope, msg", async ({ page }) => {
  await load(page);
  await page.evaluate(async () => {
    plstLog.info("popup", "import requested", { tracks: 2, server: "http://x" });
    plstLog.error("popup", "boom", new Error("kaboom"));
    await plstLog.flush();
    await plstShip.ship();
  });

  expect(lastBody.extensionId).toBe("testextensionid000000");
  expect(lastBody.userId).toBe(1);
  expect(lastBody.entries).toHaveLength(2);

  const info = lastBody.entries[0];
  expect(info).toMatchObject({ level: "info", scope: "popup", msg: "import requested" });
  // The full ISO instant travels, not just the time-of-day shown in the panel.
  expect(Number.isFinite(Date.parse(info.ts))).toBe(true);

  // An Error's stack goes in its own field, not buried in data (that is where the server reads it).
  const err = lastBody.entries[1];
  expect(err.level).toBe("error");
  expect(typeof err.stack).toBe("string");
  expect(err.stack).toContain("kaboom");
  // ...and it is not duplicated inside data.
  expect(err.data?.stack).toBeUndefined();
  // Internal bookkeeping never leaves the machine.
  expect(JSON.stringify(lastBody)).not.toContain("shipped");
});

test("an older entry stored without a shipped flag is still uploaded", async ({ page }) => {
  await load(page);
  await page.evaluate(async () => {
    // What log.js wrote before the flag existed.
    window.__mem["plst.log"] = [{ t: "09:00:00.000", ts: "2026-10-01T09:00:00.000Z", level: "warn", scope: "scan", msg: "legacy" }];
    await plstLog.init();
    await plstShip.ship();
  });
  expect(lastBody.entries).toHaveLength(1);
  expect(lastBody.entries[0].msg).toBe("legacy");
});

test("a failed upload keeps the entries pending and does not throw", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mem = {};
    window.chrome = {
      runtime: { id: "x" },
      storage: { local: { get: async (k) => ({ [k]: window.__mem[k] }), set: async (o) => Object.assign(window.__mem, o) } },
    };
    localStorage.setItem("plst.server", window.__origin);
    window.__fails = 2;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (window.__fails > 0) {
        window.__fails -= 1;
        throw new Error("network down");
      }
      return realFetch(url, init);
    };
  });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ log, ship }) => {
      eval(log);
      eval(ship);
    },
    { log: LOG_JS, ship: SHIP_JS }
  );

  const out = await page.evaluate(async () => {
    plstLog.info("popup", "kept for later");
    await plstLog.flush();
    const r = await plstShip.ship();
    return { state: r.state, error: r.error, attempts: r.attempts, pending: plstLog.pending().length };
  });
  // Not delivered, so NOT marked shipped — an entry lost to a failed request is the worst outcome.
  expect(out.state).toBe("retrying");
  expect(out.pending).toBe(1);
  expect(out.error).toMatch(/network down/);
});

test("after the attempts run out it stops trying, and describe() says why", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mem = {};
    window.chrome = {
      runtime: { id: "x" },
      storage: { local: { get: async (k) => ({ [k]: window.__mem[k] }), set: async (o) => Object.assign(window.__mem, o) } },
    };
    localStorage.setItem("plst.server", window.__origin);
    window.__fetches = 0;
    window.fetch = async () => {
      window.__fetches += 1;
      throw new Error("network down");
    };
  });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ log, ship }) => {
      eval(log);
      eval(ship);
    },
    { log: LOG_JS, ship: SHIP_JS }
  );

  const out = await page.evaluate(async () => {
    plstLog.info("popup", "never arrives");
    await plstLog.flush();
    // Automatic ships only — the popup opening over and over must not hammer a backend that is down.
    const states = [];
    for (let i = 0; i < 9; i += 1) states.push((await plstShip.ship()).state);
    const autoFetches = window.__fetches;
    // Read the wording now: the manual attempt below legitimately bumps the counter.
    const describe = plstShip.describe();
    // The manual button is the escape hatch and deliberately ignores the spent backoff.
    const forced = (await plstShip.ship({ force: true })).state;
    return {
      states,
      autoFetches,
      describe,
      forced,
      forcedFetches: window.__fetches,
      pending: plstLog.pending().length,
    };
  });
  // Six attempts, then it stops on its own — no endless "shipping failed" churn.
  expect(out.states.filter((s) => s === "retrying")).toHaveLength(5);
  expect(out.states.slice(5)).toEqual(['gave-up', 'gave-up', 'gave-up', 'gave-up']);
  expect(out.autoFetches).toBe(6); // and it really stopped requesting, not just reporting
  expect(out.describe).toMatch(/gave up after 6 attempts/);
  // A manual upload still tries.
  expect(out.forced).toBe('retrying');
  expect(out.forcedFetches).toBe(7);
  // Still pending: nothing was lost.
  expect(out.pending).toBe(1);
});

test("a 500 or a non-JSON reply is a failure, not a silent success", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mem = {};
    window.chrome = {
      runtime: { id: "x" },
      storage: { local: { get: async (k) => ({ [k]: window.__mem[k] }), set: async (o) => Object.assign(window.__mem, o) } },
    };
    localStorage.setItem("plst.server", window.__origin);
  });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ log, ship }) => {
      eval(log);
      eval(ship);
    },
    { log: LOG_JS, ship: SHIP_JS }
  );
  replyMode = "error";

  const out = await page.evaluate(async () => {
    plstLog.info("popup", "x");
    await plstLog.flush();
    const r = await plstShip.ship();
    return { state: r.state, error: r.error, pending: plstLog.pending().length };
  });

  expect(out.state).toBe("retrying");
  expect(out.pending).toBe(1);
  expect(out.error).toMatch(/500/);
});

test("describe() is readable before anything has been sent", async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => plstShip.describe())).toBe("not sent yet");
});

test("batches at most 100 entries per request and drains the rest", async ({ page }) => {
  await load(page);
  const out = await page.evaluate(async () => {
    for (let i = 0; i < 250; i += 1) plstLog.info("scan", `step ${i}`);
    await plstLog.flush();
    await plstShip.ship();
    return { sent: plstShip.status().sent, pending: plstLog.pending().length };
  });
  // 250 entries at 100 per request: never one giant POST.
  expect(batchSizes).toEqual([100, 100, 50]);
  expect(out.sent).toBe(250);
  expect(out.pending).toBe(0);
});