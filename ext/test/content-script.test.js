// Exercises the SHIPPED content.js against the virtualised fixture, rather than the copy of the
// walk logic that lives inside fixture.html. content.js is loaded for real and driven through the
// same SCAN message the popup sends, with a minimal chrome.* stub standing in for the extension.
//
// Run: npx playwright test test/content-script.test.js
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const FIXTURE = "file://" + path.join(__dirname, "fixture.html");
const CONTENT_JS = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const LOG_JS = fs.readFileSync(path.join(__dirname, "..", "log.js"), "utf8");

// Stands in for the extension: captures the SCAN listener content.js registers, and exposes
// __send() — invoke the listener with any message, resolve with whatever it passes to
// sendResponse — plus a scan() shorthand. `scrape` (optional) seeds the scrape-interval settings
// so a test can shrink the walk's per-step waits; without it the storage read fails and the
// script's defaults apply, exactly like a fresh install. Installed just before content.js is
// injected, which is the only moment it touches chrome.*.
const installChromeStub = (scrape) => {
  const listeners = [];
  window.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
      },
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        get: async (key) => (scrape ? { [key]: scrape } : {}),
      },
    },
  };
  window.__send = (msg) =>
    new Promise((resolve, reject) => {
      const fn = listeners.find(Boolean);
      if (!fn) return reject(new Error("content.js registered no onMessage listener"));
      const timer = setTimeout(() => reject(new Error(`${msg.type} never responded`)), 150_000);
      fn(msg, { id: 1 }, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      return undefined;
    });
  window.__scan = () => window.__send({ type: "SCAN" });
};

test("shipped content.js walks the virtualised fixture and returns every track", async ({ page }) => {
  // the walk deliberately dawdles (1.5s per 400px step, plus a render retry) because a real
  // Yandex page needs time to swap rows in — a full down-then-up pass over the fixture is ~35s
  test.setTimeout(180_000);
  await page.goto(FIXTURE);
  await page.evaluate(installChromeStub);
  await page.addScriptTag({ content: CONTENT_JS });
  // let the fixture's own bookkeeping walk settle so the two walks cannot interleave
  await page.waitForFunction(() => window.__walkDone === true);

  const res = await page.evaluate(() => window.__scan());
  expect(res.ok).toBe(true);

  const titles = res.data.tracks.map((t) => t.title);
  expect(res.data.count).toBe(40);
  expect(titles).toContain("song 1");
  expect(titles).toContain("song 40");
  // dedup by title: one entry per unique song, never a second copy of a re-rendered row
  expect(new Set(titles).size).toBe(40);

  // the parsed shape is what /api/library/scan stores
  const first = res.data.tracks.find((t) => t.title === "song 3");
  expect(first).toMatchObject({ title: "song 3", artists: ["artist 4"], album: "album 1" });
  expect(typeof first.durationS).toBe("number");
});

test("a page with tracks but no scroller still returns them", async ({ page }) => {
  // regression: walk() used to early-return before absorb() when no virtualised scroller was
  // found, so such a page scanned as zero tracks even though rows were rendered.
  await page.setContent(`
    <div class="CommonTrack_root">
      <div class="Meta_title">no scroller song</div>
      <div class="Meta_artists">someone</div>
      <div class="Meta_albumLink">an album</div>
      <div class="CommonControlsBar_duration">2:05</div>
    </div>
  `);
  await page.evaluate(installChromeStub);
  await page.addScriptTag({ content: CONTENT_JS });

  const res = await page.evaluate(() => window.__scan());
  expect(res.ok).toBe(true);
  expect(res.data.count).toBe(1);
  expect(res.data.tracks[0]).toMatchObject({
    title: "no scroller song",
    artists: ["someone"],
    album: "an album",
    durationS: 125,
  });
});

test("an empty page scans as zero tracks rather than throwing", async ({ page }) => {
  await page.setContent("<div>nothing here</div>");
  await page.evaluate(installChromeStub);
  await page.addScriptTag({ content: CONTENT_JS });

  const res = await page.evaluate(() => window.__scan());
  expect(res.ok).toBe(true);
  expect(res.data.count).toBe(0);
  expect(res.data.tracks).toEqual([]);
});

test("a scan leaves a trace explaining what it saw", async ({ page }) => {
  // The point of the trace: a zero-track scan must record WHY, not just return 0.
  await page.setContent(`
    <div class="CommonTrack_root">
      <div class="Meta_title">traced song</div>
      <div class="Meta_artists">someone</div>
    </div>
  `);
  await page.evaluate(installChromeStub);
  await page.addScriptTag({ content: LOG_JS });
  await page.addScriptTag({ content: CONTENT_JS });

  const entries = await page.evaluate(async () => {
    await window.__scan();
    return plstLog.entries();
  });

  const start = entries.find((e) => e.msg === "SCAN received");
  expect(start).toBeTruthy();
  expect(start.scope).toBe("content");
  // The two facts that decide whether a walk can work at all.
  expect(start.data.scroller).toEqual({ found: false });
  expect(start.data.trackRows).toBe(1);

  const done = entries.find((e) => e.msg === "SCAN finished");
  expect(done).toBeTruthy();
  expect(done.data.tracks).toBe(1);
});

test("a zero-track scan is logged as a warning with the row count", async ({ page }) => {
  await page.setContent("<div>no tracks rendered</div>");
  await page.evaluate(installChromeStub);
  await page.addScriptTag({ content: LOG_JS });
  await page.addScriptTag({ content: CONTENT_JS });

  const entries = await page.evaluate(async () => {
    await window.__scan();
    return plstLog.entries();
  });

  const warn = entries.find((e) => e.level === "warn" && /collected 0 tracks/.test(e.msg));
  expect(warn).toBeTruthy();
  expect(warn.data.trackRows).toBe(0);
  // The relay to the popup is fire-and-forget, and must not be able to break the walk.
  expect(entries.some((e) => e.msg === "SCAN finished" && e.data.tracks === 0)).toBe(true);
});

test("pause holds the walk dead still, and resume completes it with everything", async ({ page }) => {
  // A plain (non-virtualised) scroller with 40 rows: enough steps that the walk is guaranteed to
  // be mid-flight when the pause lands. Short waits keep the test fast — the mechanism under
  // test (the gate at each step boundary) doesn't care how long a step is.
  await page.setContent(`
    <div class="virtuoso-scroller" style="height:300px;overflow:auto">
      ${Array.from({ length: 40 }, (_, i) => `
        <div class="CommonTrack_root" style="height:100px">
          <div class="Meta_title">pause song ${i + 1}</div>
          <div class="Meta_artists">artist ${i + 1}</div>
        </div>`).join("")}
    </div>
  `);
  await page.evaluate(installChromeStub, { stepWaitMs: 150, retryWaitMs: 100 });
  await page.addScriptTag({ content: CONTENT_JS });

  await page.evaluate(() => {
    window.__done = false;
    window.__scan().then((r) => {
      window.__done = true;
      window.__result = r;
    });
  });
  // Let the walk get moving — one full step at minimum — before pausing.
  await page.waitForFunction(() => {
    const s = document.querySelector(".virtuoso-scroller");
    return s && s.scrollTop > 0;
  });
  const pauseReply = await page.evaluate(() => window.__send({ type: "SCAN_PAUSE" }));
  expect(pauseReply).toEqual({ ok: true, paused: true });

  // The pause lands at a STEP boundary: the step already in flight finishes, then everything is
  // frozen. So snapshot only after that in-flight step's window has certainly passed.
  await page.waitForTimeout(600);
  const frozen = await page.evaluate(() => ({
    scrollTop: document.querySelector(".virtuoso-scroller").scrollTop,
    done: window.__done,
  }));
  expect(frozen.done).toBe(false); // the walk is genuinely held, not just quiet
  await page.waitForTimeout(900);
  const stillFrozen = await page.evaluate(() => ({
    scrollTop: document.querySelector(".virtuoso-scroller").scrollTop,
    done: window.__done,
  }));
  expect(stillFrozen.scrollTop).toBe(frozen.scrollTop); // zero movement while paused
  expect(stillFrozen.done).toBe(false);

  // Resume: the walk continues and collects the WHOLE list — a pause must not cost a single row.
  const resumeReply = await page.evaluate(() => window.__send({ type: "SCAN_RESUME" }));
  expect(resumeReply).toEqual({ ok: true, paused: false });
  await page.waitForFunction(() => window.__done === true, null, { timeout: 30_000 });
  const final = await page.evaluate(() => window.__result);
  expect(final.ok).toBe(true);
  expect(final.data.count).toBe(40);
});

test("stop cuts through a pause instead of leaving the walk wedged", async ({ page }) => {
  // Regression the pause design must not reintroduce: a paused walk whose only escape hatch was
  // the step gate would hang forever if stop respected the pause. Stop wins, always.
  await page.setContent(`
    <div class="virtuoso-scroller" style="height:300px;overflow:auto">
      ${Array.from({ length: 40 }, (_, i) => `
        <div class="CommonTrack_root" style="height:100px">
          <div class="Meta_title">stop song ${i + 1}</div>
        </div>`).join("")}
    </div>
  `);
  await page.evaluate(installChromeStub, { stepWaitMs: 150, retryWaitMs: 100 });
  await page.addScriptTag({ content: CONTENT_JS });

  await page.evaluate(() => {
    window.__done = false;
    window.__scan().then((r) => {
      window.__done = true;
      window.__result = r;
    });
  });
  await page.waitForFunction(() => {
    const s = document.querySelector(".virtuoso-scroller");
    return s && s.scrollTop > 0;
  });
  await page.evaluate(() => window.__send({ type: "SCAN_PAUSE" }));
  // Pause first, THEN stop — the wedged-walk failure mode. The scan must resolve promptly
  // (the walk's own gate is the only thing that could delay it, and stop releases it).
  const stopReply = await page.evaluate(() => window.__send({ type: "SCAN_STOP" }));
  expect(stopReply.ok).toBe(true);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 5000 });
  const final = await page.evaluate(() => window.__result);
  // It RESOLVES — that is the whole assertion. A paused-then-stopped walk that hangs would fail
  // the waitForFunction above. (The count is full here only because this fixture renders every
  // row at once, so even the first collect sees all 40.)
  expect(final.ok).toBe(true);
  expect(final.data.count).toBeGreaterThan(0);
});
