// Which backend the extension talks to, and the buttons that change it. These are static-file
// assertions rather than browser ones on purpose: the failure they guard against is a default or a
// button drifting out of sync with each other, which no amount of driving the popup would catch —
// the popup would simply keep talking to a server nobody meant, which is the exact bug class this
// whole feature exists to make visible.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const POPUP_JS = read("popup.js");
const SHIP_JS = read("ship.js");
const POPUP_HTML = read("popup.html");
const MANIFEST = JSON.parse(read("manifest.json"));

// The one URL everything must agree on. popup.js and ship.js each keep their own copy of the
// default (ship.js deliberately does not import from popup.js — it also runs on pagehide), so a
// disagreement between the two is silent and only shows up as logs shipping to the wrong host.
const RENDER = "https://evidence-qulg.onrender.com";
const LOCAL = "http://localhost:3218";

test("the default backend is the render instance, in popup.js and ship.js alike", () => {
  expect(POPUP_JS).toContain(`DEFAULT_SERVER = "${RENDER}"`);
  expect(SHIP_JS).toContain(`DEFAULT_SERVER = "${RENDER}"`);
  // The old default must be gone, not merely no longer first: a leftover 127.0.0.1:8000 in
  // ship.js would ship logs to a server that is not running.
  expect(POPUP_JS).not.toContain("127.0.0.1:8000");
  expect(SHIP_JS).not.toContain("127.0.0.1:8000");
});

test("popup.html's placeholder and help text match the default", () => {
  // A placeholder naming a different host than the code uses is how someone ends up typing the
  // URL that is already the default, or believing the field is broken.
  expect(POPUP_HTML).toContain(`placeholder="${RENDER}"`);
  expect(POPUP_HTML).toContain(`Default ${RENDER}`);
});

test("the manifest statically grants the default backend's host", () => {
  // Without this, the very first import against the default asks for a permission grant, and a
  // denial reads as "the server is down". localhost/127.0.0.1 are static too — the extension is
  // useless without reaching a backend at all.
  expect(MANIFEST.host_permissions).toContain(`${RENDER}/*`);
  expect(MANIFEST.host_permissions).toContain("http://localhost/*");
  expect(MANIFEST.host_permissions).toContain("http://127.0.0.1/*");
  // Other https hosts stay opt-in — the extension must not ask for the whole web at install time.
  expect(MANIFEST.optional_host_permissions).toContain("https://*/*");
});

test("both quick-set buttons exist and their URLs are the ones popup.js saves", () => {
  // The buttons are the only non-typed path to the right URL, so a dead id (renamed in the HTML,
  // not in the JS) leaves them silently doing nothing.
  expect(POPUP_HTML).toContain('id="setRender"');
  expect(POPUP_HTML).toContain('id="setLocal"');
  expect(POPUP_JS).toContain(`url: "${RENDER}"`);
  expect(POPUP_JS).toContain(`url: "${LOCAL}"`);
});

test("the popup renders the get-updates status line and waits long enough for a cold start", () => {
  // Render's free instance cold-starts from asleep and can take tens of seconds. A short timeout
  // would report a healthy backend as dead, which is worse than waiting: it sends people chasing
  // a server that is merely waking up.
  const html = read("popup.html");
  expect(html).toContain('id="serverStatus"');
  expect(POPUP_JS).toMatch(/GET_UPDATES_TIMEOUT_MS\s*=\s*([0-9_]+)/);
  const ms = Number(/GET_UPDATES_TIMEOUT_MS\s*=\s*([0-9_]+)/.exec(POPUP_JS)[1].replace(/_/g, ""));
  expect(ms).toBeGreaterThanOrEqual(60_000);
  // and the check really is wired to the backend's own endpoint, at popup open
  expect(POPUP_JS).toContain("/api/get-updates");
  expect(POPUP_JS).toContain("void checkBackend();");
});
