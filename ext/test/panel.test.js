// The panel is three top-level tabs, it is side-panel-only, and the scrape intervals have to cross
// a boundary that is easy to get wrong: they are written by the extension page and read by a
// content script living on music.yandex.ru. Those are structural facts, so most of this is
// static-file assertion — a subtitle drifting out of sync, or an input left on the wrong tab, is
// invisible to a test that only drives the happy path. The one browser test below covers what
// static checks cannot: that the tabs actually switch and the interval inputs really round-trip
// through chrome.storage.local.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const http = require("http");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const POPUP_HTML = read("popup.html");
const POPUP_JS = read("popup.js");
const CONTENT_JS = read("content.js");
const BACKGROUND_JS = read("background.js");
const MANIFEST = JSON.parse(read("manifest.json"));

// The markup of ONE top-level panel. Slicing by <section id="panel-x"> makes "is this element in
// the right tab" a real assertion; a bare substring match would pass with the element parked in
// whichever section happened to contain the text.
const panel = (name) => {
  const start = POPUP_HTML.indexOf(`<section id="panel-${name}"`);
  if (start < 0) return "";
  const end = POPUP_HTML.indexOf("</section>", start);
  return POPUP_HTML.slice(start, end < 0 ? POPUP_HTML.length : end);
};

// The defaults, pulled from each file so the test compares them rather than asserting one literal
// twice. Two copies that silently disagree is exactly the failure this guards.
const scrapeDefaults = (src) => {
  const m = /DEFAULT_SCRAPE\s*=\s*\{\s*stepWaitMs:\s*(\d+),\s*retryWaitMs:\s*(\d+)\s*\}/.exec(src);
  return m ? { stepWaitMs: Number(m[1]), retryWaitMs: Number(m[2]) } : null;
};

test("the panel opens on three top-level tabs, with scan selected", () => {
  // Counted from role="tab" so a stray button in the markup cannot be mistaken for a tab.
  expect(POPUP_HTML.match(/role="tab"/g)).toHaveLength(3);
  expect(POPUP_HTML).toContain('id="tab-scan"');
  expect(POPUP_HTML).toContain('id="tab-settings"');
  expect(POPUP_HTML).toContain('id="tab-logs"');
  // A missing or duplicated panel id would leave a tab clicking into nothing.
  for (const name of ["scan", "settings", "logs"]) {
    expect(POPUP_HTML.match(new RegExp(`id="panel-${name}"`, "g"))).toHaveLength(1);
  }
  // Scan is the default: it starts selected and its panel starts visible.
  expect(POPUP_HTML).toMatch(/id="tab-scan"[^>]*aria-selected="true"/);
  expect(POPUP_HTML).toMatch(/id="panel-scan"[^>]*class="panel active"/);
});

test("settings and the scrape intervals live in the settings tab, not the scan tab", () => {
  const settings = panel("settings");
  const scan = panel("scan");
  // The server/user block moved out of the scan tab...
  for (const id of ["serverBox", "server", "saveServer", "setRender", "setLocal", "userId", "serverStatus"]) {
    expect(settings).toContain(`id="${id}"`);
    expect(scan).not.toContain(`id="${id}"`);
  }
  // ...and the two interval inputs are there beside it.
  expect(settings).toContain('id="stepWaitMs"');
  expect(settings).toContain('id="retryWaitMs"');
  // Both are millisecond fields with the same clamp the code enforces, so the HTML cannot promise
  // a range the JS disagrees about.
  for (const id of ["stepWaitMs", "retryWaitMs"]) {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(settings)[0];
    expect(tag).toContain('type="number"');
    expect(tag).toContain('min="0"');
    expect(tag).toContain('max="10000"');
  }
});

test("the scan actions stay on the scan tab and the diagnostics stay on the logs tab", () => {
  const scan = panel("scan");
  const logs = panel("logs");
  for (const id of ["scan", "import", "convert", "msg", "out", "log", "sum", "res"]) {
    expect(scan).toContain(`id="${id}"`);
  }
  for (const id of ["diaglog", "shipLog", "copyLog", "openLog", "clearLog", "logship"]) {
    expect(logs).toContain(`id="${id}"`);
    expect(scan).not.toContain(`id="${id}"`);
  }
});

test("the extension is side-panel-only: no popup, and a worker that arms the panel", () => {
  // Dropping default_popup is the load-bearing half. Leaving it in would keep the old popup alive
  // alongside the panel, which is the "it opened in two places" confusion this removes.
  expect(MANIFEST.action).not.toHaveProperty("default_popup");
  expect(MANIFEST.action.default_title).toBe("plst");
  expect(MANIFEST.side_panel.default_path).toBe("popup.html");
  expect(MANIFEST.background.service_worker).toBe("background.js");
  // setPanelBehavior is only callable from a worker or an extension page, so it must be in the
  // worker, and it must ask for exactly this behaviour — otherwise the toolbar click does nothing.
  expect(BACKGROUND_JS).toContain("setPanelBehavior");
  expect(BACKGROUND_JS).toMatch(/setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true\s*\}\)/);
  expect(BACKGROUND_JS).toMatch(/onInstalled\.addListener/);
  expect(BACKGROUND_JS).toMatch(/onStartup\.addListener/);
  // The button that used to open the panel by hand is obsolete now, and must be gone rather than
  // left as a dead control.
  expect(POPUP_HTML).not.toContain("openside");
  expect(POPUP_JS).not.toContain("openside");
});

test("tab targeting uses lastFocusedWindow, which a side panel needs", () => {
  // Inside a side panel `currentWindow` can resolve to the panel's own window, so scan and import
  // would silently target the wrong tab (or none). This is the difference between the panel
  // working and it doing nothing at all.
  expect(POPUP_JS).not.toContain("currentWindow");
  expect(POPUP_JS.match(/lastFocusedWindow/g).length).toBeGreaterThanOrEqual(3);
});

test("the scrape intervals are wired popup -> storage -> content script", () => {
  // One key, or the content script reads a name the popup never wrote.
  expect(POPUP_JS).toContain('SCRAPE_KEY = "plst.scrape"');
  expect(CONTENT_JS).toContain('SCRAPE_KEY = "plst.scrape"');
  // Two copies of the defaults that disagree would make the panel show one thing and the walk use
  // another — so they are compared, not merely searched for.
  const fromPopup = scrapeDefaults(POPUP_JS);
  const fromContent = scrapeDefaults(CONTENT_JS);
  expect(fromPopup).not.toBeNull();
  expect(fromContent).toEqual(fromPopup);
  // The channel itself: written by the page, read by the content script.
  expect(POPUP_JS).toContain("chrome.storage.local.set");
  expect(CONTENT_JS).toContain("chrome.storage.local.get");
  // And the old hardcoded waits must be gone, not merely no longer first — a leftover wait(1500)
  // would make the setting a lie that only shows up as a scan that ignores it.
  expect(CONTENT_JS).not.toMatch(/wait\(\s*1500\s*\)/);
  expect(CONTENT_JS).not.toMatch(/wait\(\s*1000\s*\)/);
  // Both waits are actually threaded into the walk.
  expect(CONTENT_JS).toMatch(/wait\(cfg\.stepWaitMs\)/);
  expect(CONTENT_JS).toMatch(/collectWithRetry\(cfg\.retryWaitMs\)/);
});

test("no leftover references to the old popup-only or single-window behaviour", () => {
  // Anything still assuming a popup would keep working in the tests and misbehave in the panel.
  expect(POPUP_JS).not.toContain("chrome.sidePanel.open");
  expect(POPUP_JS).not.toContain("default_popup");
});

test("a toolbar click opens the panel even if the persisted preference is not armed", () => {
  // setPanelBehavior persists a preference; if that preference never got set (or was lost), the
  // click would do NOTHING — per Chrome docs, action.onClicked fires exactly when
  // openPanelOnActionClick is NOT armed. So the worker must also handle onClicked and call
  // sidePanel.open directly; onClicked is a documented valid user gesture for that call. The two
  // paths can never both run for one click, so this is a true fallback, not a double-open.
  expect(BACKGROUND_JS).toMatch(/chrome\.action\.onClicked\.addListener/);
  expect(BACKGROUND_JS).toMatch(/sidePanel\s*\.\s*open\(\{\s*windowId/);
  // Both mechanisms belong in the worker, never in the panel document (which does not exist until
  // the panel opens — the whole reason the worker exists).
  expect(POPUP_JS).not.toContain("chrome.sidePanel.open");
  // The worker logs into the SAME ring buffer the panel shows and ships, so the next
  // "click does nothing" report is answerable from logs instead of guesses. log.js is DOM-free
  // and storage-guarded, which is what makes importScripts safe here.
  expect(BACKGROUND_JS).toContain('importScripts("log.js")');
  expect(BACKGROUND_JS).toMatch(/"action click/);
  expect(BACKGROUND_JS).toMatch(/"panel behavior armed/);
  // Guarded, not bare: a missing log.js must degrade to no logging, not kill the worker and take
  // the panel-opening behaviour down with it.
  expect(BACKGROUND_JS).toMatch(/try\s*{[^}]*importScripts\("log\.js"\)[^}]*\} catch/s);
  // This change altered click behaviour, so the version moved with it.
  expect(MANIFEST.version).toBe("0.5.3");
});

test("a scan into a missing content script reloads the yandex tab and retries", () => {
  // The mechanism (reported live 2026-10-13): reloading the extension does NOT re-inject the
  // content script into already-open tabs, and the old copy is ORPHANED — so sendMessage fails
  // with "Receiving end does not exist" even on a perfect music.yandex page. The panel must
  // heal that mechanically instead of blaming the page.
  expect(POPUP_JS).toMatch(/Receiving end does not exist/i);
  expect(POPUP_JS).toContain('chrome.tabs.reload');
  expect(POPUP_JS).toMatch(/onUpdated\.addListener/);
  expect(POPUP_JS).toMatch(/status === 'complete'/);
  expect(POPUP_JS).toContain('music\\.yandex\\.(ru|kz)');
  expect(POPUP_JS).toMatch(/retrying/i);
  // The URL confirmation needs host access to the yandex pages — without it tab.url is hidden
  // from the panel and the heal would have nothing to confirm.
  expect(MANIFEST.host_permissions).toContain('https://music.yandex.ru/*');
  expect(MANIFEST.host_permissions).toContain('https://music.yandex.kz/*');
});

test("while a scan runs, the panel offers pause/stop icons and disables everything else", () => {
  // The three asks (one message, 2026-10-13): other buttons off during a scan; "Scan tab" swaps
  // for pause (⏸) + stop (⏹) icon buttons while the walk is active; pause must be a REAL pause
  // in the content script, not just a greyed-out icon.
  const HTML = POPUP_HTML;
  expect(HTML).toMatch(/id="scanControls"/);
  expect(HTML).toMatch(/id="pauseScan"[^>]*>⏸/);
  expect(HTML).toMatch(/id="stopScanTop"[^>]*>⏹/);
  // The controls start hidden — the swap is driven by the scanning state, not the markup. And
  // the flex rule must be :not(.hidden)-scoped: a bare #scanControls{display:flex} outranks
  // .hidden on specificity (id beats class) and would show the controls ALL the time (caught
  // live by the browser test below before this rule was scoped).
  expect(HTML).toMatch(/id="scanControls" class="hidden"/);
  expect(HTML).toMatch(/#scanControls:not\(\.hidden\)/);
  expect(HTML).not.toMatch(/#scanControls \{ display: flex/);
  // One function owns the disabled logic so "no results" and "scanning" can't disagree.
  expect(POPUP_JS).toMatch(/const syncButtons = \(\) =>/);
  expect(POPUP_JS).toMatch(/importBtn\.disabled = scanning \|\| noResults/);
  expect(POPUP_JS).toMatch(/convertBtn\.disabled = scanning \|\| noResults/);
  expect(POPUP_JS).toContain('SCAN_PAUSE');
  expect(POPUP_JS).toContain('SCAN_RESUME');
  // And the content script actually gates the walk on the flag (see content-script.test.js for
  // the behavioural proof that the walk freezes and resumes).
  expect(CONTENT_JS).toMatch(/const gate = async \(\) =>/);
  expect(CONTENT_JS).toMatch(/await gate\(\)/);
  expect(CONTENT_JS).toMatch(/"SCAN_PAUSE"/);
  expect(CONTENT_JS).toMatch(/"SCAN_RESUME"/);
});

/* ------------------------------------------------------------------ the real, clickable panel */

const EXT_DIR = path.join(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };
let server;
let origin;

test.beforeAll(async () => {
  // Served over http rather than about:blank: localStorage throws on opaque origins, and popup.js
  // reads it on load. The real panel runs on chrome-extension://, which also has a real origin.
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "popup.html";
    const file = path.join(EXT_DIR, rel);
    if (!file.startsWith(EXT_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

test("the tabs switch, and an interval round-trips through chrome.storage.local", async ({ page }) => {
  // Seed one saved value so the "did it really load what was stored" half has something to read.
  await page.addInitScript(() => {
    window.__mem = { "plst.scrape": { stepWaitMs: 250, retryWaitMs: 700 } };
    window.chrome = {
      runtime: {
        id: "panel-test-extension",
        onMessage: { addListener: () => {} },
        getManifest: () => ({ version: "0.0.0-test" }),
        getURL: (p) => p,
      },
      storage: {
        local: {
          get: async (k) => ({ [k]: window.__mem[k] }),
          set: async (o) => Object.assign(window.__mem, o),
        },
      },
      tabs: { query: async () => [], sendMessage: async () => {}, create: () => {} },
      permissions: { contains: async () => true, request: async () => true },
      sidePanel: { open: async () => {} },
    };
    // ship.js would otherwise POST to the real render host from inside a test run.
    window.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await page.goto(`${origin}/popup.html`);

  // Scan is what opens.
  await expect(page.locator("#panel-scan")).toBeVisible();
  await expect(page.locator("#panel-settings")).toBeHidden();

  // Clicking a tab swaps the panels and the selected state together.
  await page.click("#tab-settings");
  await expect(page.locator("#panel-settings")).toBeVisible();
  await expect(page.locator("#panel-scan")).toBeHidden();
  await expect(page.locator("#tab-settings")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tab-scan")).toHaveAttribute("aria-selected", "false");

  // The stored intervals reached the inputs.
  await expect(page.locator("#stepWaitMs")).toHaveValue("250");
  await expect(page.locator("#retryWaitMs")).toHaveValue("700");

  // Editing one writes it back AND leaves the other alone — a save that clobbers the sibling field
  // is the failure that would make the second setting impossible to keep. `change` is dispatched
  // explicitly because that is what a real blur/Enter does; fill() alone only fires `input`.
  await page.fill("#stepWaitMs", "400");
  await page.locator("#stepWaitMs").dispatchEvent("change");
  await page.waitForFunction(() => window.__mem["plst.scrape"]?.stepWaitMs === 400);
  const saved = await page.evaluate(() => window.__mem["plst.scrape"]);
  expect(saved.stepWaitMs).toBe(400);
  expect(saved.retryWaitMs).toBe(700);

  // And the third tab is reachable too.
  await page.click("#tab-logs");
  await expect(page.locator("#panel-logs")).toBeVisible();
  await expect(page.locator("#panel-settings")).toBeHidden();
});

test("a dead content script is healed: the tab reloads and the scan retries", async ({ page }) => {
  // The real regression, reproduced end to end: first sendMessage fails the way an ORPHANED
  // content script fails after an extension reload ("Receiving end does not exist"), the panel
  // reloads the yandex tab, and the SECOND attempt goes through.
  await page.addInitScript(() => {
    window.__mem = {};
    window.__attempts = 0;
    window.__reloads = 0;
    window.chrome = {
      runtime: {
        id: "panel-test-extension",
        onMessage: { addListener: () => {} },
        getManifest: () => ({ version: "0.0.0-test" }),
        getURL: (p) => p,
      },
      storage: {
        local: {
          get: async (k) => ({ [k]: window.__mem[k] }),
          set: async (o) => Object.assign(window.__mem, o),
        },
      },
      tabs: {
        query: async () => [{ id: 5, url: "https://music.yandex.ru/playlist/1" }],
        create: () => {},
        sendMessage: async () => {
          window.__attempts += 1;
          if (window.__attempts === 1) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          return { ok: true, data: { tracks: [], count: 0, dupCount: 0, skippedCount: 0 } };
        },
        reload: async () => {
          window.__reloads += 1;
          // A reload completes → onUpdated "complete", which is what reloadAndWait listens for.
          setTimeout(() => window.__onUpdated(5, { status: "complete" }), 10);
        },
        onUpdated: {
          addListener: (fn) => {
            window.__onUpdated = fn;
          },
          removeListener: () => {},
        },
      },
      permissions: { contains: async () => true, request: async () => true },
      sidePanel: { open: async () => {} },
    };
    window.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await page.goto(`${origin}/popup.html`);

  await page.click("#scan");
  await page.waitForFunction(() => window.__attempts === 2, null, { timeout: 5000 });
  // Exactly one reload, and the retry is what answered — not a second user click.
  expect(await page.evaluate(() => window.__reloads)).toBe(1);
  // The empty retry result flows into the normal "no tracks" message: the heal is invisible
  // once it works, which is the point.
  await expect(page.locator("#msg")).toContainText("no tracks found");
  // And the whole episode is in the diagnostics log, named rather than implied.
  const logText = await page.evaluate(() => window.__mem["plst.log"]?.map((e) => e.msg).join("\n") ?? "");
  expect(logText).toContain("reloading it and retrying");
  expect(logText).toContain("scan retry after tab reload");
});

test("a running scan swaps in pause/stop and disables the result buttons until it ends", async ({ page }) => {
  // The mid-scan state, driven for real: the SCAN reply is held open by the test so the panel is
  // caught IN the running state — that is when pause/stop must be showing and import/convert/
  // copy must be dead. Then the reply lands and everything returns to normal.
  await page.addInitScript(() => {
    window.__mem = {};
    window.__scanResolve = null; // the test holds the scan's answer in its own hands
    window.chrome = {
      runtime: {
        id: "panel-test-extension",
        onMessage: { addListener: () => {} },
        getManifest: () => ({ version: "0.0.0-test" }),
        getURL: (p) => p,
      },
      storage: {
        local: {
          get: async (k) => ({ [k]: window.__mem[k] }),
          set: async (o) => Object.assign(window.__mem, o),
        },
      },
      tabs: {
        query: async () => [{ id: 5, url: "https://music.yandex.ru/playlist/1" }],
        create: () => {},
        // The first message is the SCAN and it PENDS until the test releases it; anything else
        // (SCAN_PAUSE / SCAN_RESUME / SCAN_STOP) answers immediately and is recorded.
        sendMessage: async (_id, msg) => {
          (window.__sent ??= []).push(msg.type);
          if (msg.type === "SCAN") {
            return new Promise((r) => {
              window.__scanResolve = r;
            });
          }
          return { ok: true };
        },
        reload: async () => {},
        onUpdated: { addListener: () => {}, removeListener: () => {} },
      },
      permissions: { contains: async () => true, request: async () => true },
      sidePanel: { open: async () => {} },
    };
    window.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await page.goto(`${origin}/popup.html`);

  // Before the scan: the normal button, no pause/stop in sight.
  await expect(page.locator("#scan")).toBeVisible();
  await expect(page.locator("#scanControls")).toBeHidden();

  await page.click("#scan");
  // The scan is now in flight (its answer is still held by the test).
  await page.waitForFunction(() => window.__scanResolve !== null);
  await expect(page.locator("#scan")).toBeHidden();
  await expect(page.locator("#scanControls")).toBeVisible();
  // Everything that acts on results is dead while the results are still moving.
  await expect(page.locator("#import")).toBeDisabled();
  await expect(page.locator("#convert")).toBeDisabled();
  await expect(page.locator("#copyJson")).toBeDisabled();

  // Pause toggles the icon AND reaches the content script as SCAN_PAUSE.
  await page.click("#pauseScan");
  expect(await page.evaluate(() => window.__sent)).toContain("SCAN_PAUSE");
  await expect(page.locator("#pauseScan")).toHaveText("▶");
  await page.click("#pauseScan"); // resume
  expect(await page.evaluate(() => window.__sent)).toContain("SCAN_RESUME");
  await expect(page.locator("#pauseScan")).toHaveText("⏸");

  // The scan ends with one track — buttons come back, and the non-empty result re-enables import.
  await page.evaluate(() =>
    window.__scanResolve({
      ok: true,
      data: {
        tracks: [{ title: "t1", artists: ["a1"], album: null, durationS: 100, yandexUrl: "u" }],
        count: 1,
        dupCount: 0,
        skippedCount: 0,
      },
    })
  );
  await expect(page.locator("#scan")).toBeVisible();
  await expect(page.locator("#scanControls")).toBeHidden();
  await expect(page.locator("#import")).toBeEnabled();
  await expect(page.locator("#pauseScan")).toHaveText("⏸"); // reset for next time
});
