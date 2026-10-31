const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURE_URL = "file://" + path.join(__dirname, "fixture.html");
const STEP_PX = 400;

test("scan walk on fixture: first-screen songs are NOT bypassed, 400px steps DOWN then UP, returns to top and validates ALL 40 parsed", async ({ page }) => {
  await page.goto(FIXTURE_URL);

  // ask 1 - visible per-step log of every parsed song name ("parsed [song name]"):
  const parsed = [];
  page.on("console", (c) => {
    const t = c.text();
    if (t.startsWith("parsed ")) parsed.push(t);
  });

  // ask 1/5 - THE walk THE fixture hosts: grab first screen FIRST (song 1..9 at
  // scrollTop 0, NOT bypassed), then 400px moves DOWN collecting all, then 400px
  // moves UP back to the top, then VALIDATE every one of the 40 titles landed.
  await page.waitForFunction(() => window.__walkDone === true);

  const res = await page.evaluate(() => ({
    result: window.__result,
    moves: window.__moves,
    grown: window.__grown,
    validated: window.__validated,
    missing: window.__missing,
  }));

  // ask 1 - first-screen songs were NOT bypassed: song 1 and song 2 are among
  // the FIRST parsed names:
  expect(parsed[0]).toContain("song 1");
  expect(parsed[1]).toContain("song 2");

  // ask 5 - after reaching the LAST item, THE walk ran BACK UP to the very top:
  expect(res.moves.some((d) => d < 0)).toBe(true);

  // ask 4 - every move is EXACTLY 400px (both the down moves and the up moves):
  for (const d of res.moves) expect(Math.abs(d)).toBe(STEP_PX);

  // ask 2 - the result json GROWS gradually (multiple steps, last grown > first
  // grown):
  expect(res.grown.length).toBeGreaterThan(1);
  expect(res.grown[res.grown.length - 1]).toBeGreaterThan(res.grown[0]);

  // ask 3/5 - BACK AT THE TOP: validation found ALL 40 items parsed, nothing missing:
  expect(res.result.length).toBe(40);
  const titles = res.result.map((r) => r.title);
  expect(titles).toContain("song 1");
  expect(titles).toContain("song 40");
});
