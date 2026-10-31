// The logger is the thing that has to work when everything else is broken, so it gets tested for
// the failure modes that matter: no chrome.storage, a throwing storage quota, the ring cap, and
// Errors surviving a JSON round-trip.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const http = require("http");

const LOG_JS = fs.readFileSync(path.join(__dirname, "..", "log.js"), "utf8");

// Served over http rather than loaded from about:blank, because localStorage throws on opaque
// origins and the level filter reads it. The extension itself runs on chrome-extension://, which
// has a real origin, so this matches how it is actually used.
let server;
let origin;
test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>log test</title><body></body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** In-memory chrome.storage.local stand-in, optionally made to fail. */
const storageStub = (opts = {}) => {
  const store = {};
  return {
    store,
    get: async (key) => (opts.throwOnGet ? Promise.reject(new Error("no storage")) : { [key]: store[key] }),
    set: async (obj) => {
      if (opts.throwOnSet) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(store, obj);
    },
  };
};

const load = async (page, { storage = true, throwOnSet = false, localStorageLevel = "info" } = {}) => {
  await page.addInitScript(
    ({ withStorage, bad, level }) => {
      window.__mem = {};
      if (withStorage) {
        window.chrome = {
          storage: {
            local: {
              get: async (k) => (bad ? Promise.reject(new Error("no storage")) : { [k]: window.__mem[k] }),
              set: async (o) => {
                if (bad === "set") throw new Error("QUOTA_BYTES quota exceeded");
                Object.assign(window.__mem, o);
              },
            },
          },
        };
      }
      try {
        localStorage.setItem("plst.logLevel", level);
      } catch {
        /* ignore */
      }
    },
    { withStorage: storage, bad: throwOnSet ? "set" : false, level: localStorageLevel },
  );
  await page.goto(origin);
  await page.addScriptTag({ content: LOG_JS });
};

test("logs to the console and keeps entries in memory", async ({ page }) => {
  await load(page);
  const out = await page.evaluate(() => {
    const got = [];
    const realLog = console.log;
    const realWarn = console.warn;
    const realError = console.error;
    const cap = (real) => (...a) => { got.push(a.join(" ")); };
    console.log = cap(realLog);
    console.warn = cap(realWarn);
    console.error = cap(realError);
    plstLog.info("test", "hello", { n: 1 });
    plstLog.warn("test", "careful");
    plstLog.error("test", "bad", new Error("x"));
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
    return { got, entries: plstLog.entries() };
  });

  expect(out.entries).toHaveLength(3);
  expect(out.entries[0]).toMatchObject({ level: "info", scope: "test", msg: "hello", data: { n: 1 } });
  expect(out.entries[1].level).toBe("warn");
  expect(out.entries[2].level).toBe("error");
  const all = out.got.join("\n");
  expect(all).toContain("[test] hello");
  expect(all).toContain("[test] careful");
  expect(all).toContain("[test] bad");
});

test("survives having no chrome.storage at all", async ({ page }) => {
  await load(page, { storage: false });
  const res = await page.evaluate(async () => {
    plstLog.info("test", "no storage here");
    await plstLog.flush();
    return { entries: plstLog.entries(), text: plstLog.text() };
  });
  expect(res.entries).toHaveLength(1);
  expect(res.text).toContain("no storage here");
});

test("a throwing storage quota does not break logging", async ({ page }) => {
  // storage.set rejects for quota reasons on a real profile; a log call must still succeed.
  await load(page, { throwOnSet: true });
  const res = await page.evaluate(async () => {
    let threw = null;
    try {
      plstLog.info("test", "still works");
      await plstLog.flush();
    } catch (e) {
      threw = String(e);
    }
    return { threw, entries: plstLog.entries() };
  });
  expect(res.threw).toBeNull();
  expect(res.entries).toHaveLength(1);
});

test("persists to storage and reloads it on the next page", async ({ page }) => {
  await load(page);
  await page.evaluate(() => plstLog.info("test", "survives reopen", { k: "v" }));

  // Stand in for the popup closing and reopening: the in-page logger instance is thrown away and
  // a brand new one boots against the same storage. (A real navigation would also work, but the
  // storage stub lives in the document, so a reload would wipe it.)
  const entries = await page.evaluate(async (src) => {
    await plstLog.flush();
    delete window.plstLog;
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    await plstLog.init();
    return plstLog.entries();
  }, LOG_JS);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ scope: "test", msg: "survives reopen", data: { k: "v" } });
});

test("caps the ring at 300 entries, dropping the oldest", async ({ page }) => {
  await load(page);
  const res = await page.evaluate(async () => {
    for (let i = 0; i < 350; i++) plstLog.info("bulk", `entry ${i}`);
    await plstLog.flush();
    const e = plstLog.entries();
    return { len: e.length, first: e[0].msg, last: e[e.length - 1].msg };
  });
  expect(res.len).toBe(300);
  expect(res.first).toBe("entry 50");
  expect(res.last).toBe("entry 349");
});

test("debug is dropped at the default level but kept when asked for", async ({ page }) => {
  await load(page);
  const off = await page.evaluate(() => {
    plstLog.debug("t", "chatter");
    return plstLog.entries().length;
  });
  expect(off).toBe(0);

  await load(page, { localStorageLevel: "debug" });
  const on = await page.evaluate(() => {
    plstLog.debug("t", "chatter");
    return plstLog.entries().length;
  });
  expect(on).toBe(1);
});

test("an Error is stored with its stack instead of becoming {}", async ({ page }) => {
  await load(page);
  const entry = await page.evaluate(() => {
    plstLog.error("popup", "boom", new Error("kaboom"));
    return plstLog.entries().at(-1);
  });
  // The whole point: the failure survives a storage round-trip with a usable message.
  expect(entry.level).toBe("error");
  expect(entry.data.message).toBe("kaboom");
  expect(entry.data.name).toBe("Error");
  expect(typeof entry.data.stack).toBe("string");
});

test("text() renders a copy-pasteable line per entry", async ({ page }) => {
  await load(page);
  const text = await page.evaluate(() => {
    plstLog.info("popup", "import accepted", { importId: 7 });
    return plstLog.text();
  });
  expect(text).toContain("[popup] import accepted");
  expect(text).toContain('{"importId":7}');
});

test("clear() empties the buffer and the stored copy", async ({ page }) => {
  await load(page);
  const res = await page.evaluate(async () => {
    plstLog.info("t", "one");
    plstLog.clear();
    await plstLog.flush();
    return { entries: plstLog.entries(), stored: window.__mem["plst.log"] };
  });
  expect(res.entries).toEqual([]);
  expect(res.stored).toEqual([]);
});

test("the manifest grants the storage permission the log depends on", () => {
  // Regression guard, and the subtlest bug found while building this: chrome.storage.* is gated
  // behind the "storage" permission, and WITHOUT it the API is simply absent — log.js degrades to
  // memory-only and every trace is lost when the popup closes, with no error anywhere. The unit
  // tests above could never catch it, because they inject their own chrome.storage stub.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  expect(manifest.permissions).toContain("storage");
});

test("logs.html loads its script from a file, not inline", () => {
  // The MV3 default CSP is script-src 'self'. An inline <script> in an extension page is refused
  // outright, which leaves a page that renders an empty table and logs nothing about it.
  const html = fs.readFileSync(path.join(__dirname, "..", "logs.html"), "utf8");
  const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scriptTags.length).toBeGreaterThan(0);
  for (const tag of scriptTags) {
    expect(tag).toMatch(/\ssrc=/); // every tag must reference an external file
  }
  expect(html).toContain('src="logs.js"');
  // and the file it references must actually exist
  expect(fs.existsSync(path.join(__dirname, "..", "logs.js"))).toBe(true);
});

test("popup.html loads log.js before popup.js", () => {
  // popup.js calls plstLog at load time, so the order is load-bearing.
  const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  expect(html.indexOf('src="log.js"')).toBeGreaterThan(-1);
  expect(html.indexOf('src="log.js"')).toBeLessThan(html.indexOf('src="popup.js"'));
});

test("the content script bundle loads log.js before content.js", () => {
  // Same reason: content.js traces through plstLog.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const files = manifest.content_scripts[0].js;
  expect(files.indexOf("log.js")).toBeGreaterThan(-1);
  expect(files.indexOf("log.js")).toBeLessThan(files.indexOf("content.js"));
});
