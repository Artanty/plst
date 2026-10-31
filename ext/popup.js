(() => {
  const msg = document.getElementById("msg");
  const btn = document.getElementById("scan");
  const out = document.getElementById("out");
  const log = document.getElementById("log");
  const copyBtn = document.getElementById("copyJson");
  const stopBtn = document.getElementById("stopScan");
  const scanControls = document.getElementById("scanControls");
  const pauseScan = document.getElementById("pauseScan");
  const stopScanTop = document.getElementById("stopScanTop");

  const convertBtn = document.getElementById("convert");
  const importBtn = document.getElementById("import");
  const serverInput = document.getElementById("server");
  const saveServerBtn = document.getElementById("saveServer");
  const serverStatus = document.getElementById("serverStatus");
  const userIdInput = document.getElementById("userId");
  const sumEl = document.getElementById("sum");
  const resEl = document.getElementById("res");
  const copyLinksBtn = document.getElementById("copyLinks");
  const openJob = document.getElementById("openJob");
  const diaglog = document.getElementById("diaglog");
  const copyLogBtn = document.getElementById("copyLog");
  const shipLogBtn = document.getElementById("shipLog");
  const logShip = document.getElementById("logship");
  const openLogBtn = document.getElementById("openLog");
  const clearLogBtn = document.getElementById("clearLog");
  // Settings-tab inputs for the scrape waits that live inside content.js.
  const stepWaitInput = document.getElementById("stepWaitMs");
  const retryWaitInput = document.getElementById("retryWaitMs");
  const scrapeStatus = document.getElementById("scrapeStatus");

  const DEFAULT_SERVER = "https://evidence-qulg.onrender.com";
  // One backend for everything the popup does, plus the local dev server. Two buttons rather than
  // typing: switching between them wrongly is the usual reason a scan "does nothing" (it went to a
  // server that was not the one with your library in it).
  const QUICK_SETS = [
    { id: "setRender", label: "render (prod)", url: "https://evidence-qulg.onrender.com" },
    { id: "setLocal", label: "local :3218", url: "http://localhost:3218" },
  ];
  // The backend's own /api/get-updates answers fast when it is awake (measured 0.3s) but a Render
  // free instance cold-starts from asleep and can legitimately take a minute. A short timeout here
  // would report a healthy backend as dead, so it waits — and it is fire-and-forget, the popup is
  // usable while it hangs.
  const GET_UPDATES_TIMEOUT_MS = 90_000;
  // The waits inside content.js, exposed as settings. They MUST travel through
  // chrome.storage.local, never localStorage: a content script runs on music.yandex.ru, so the
  // extension's localStorage sits on a different origin and is unreadable from there — which is
  // exactly why content.js had no settings at all before this. chrome.storage.local is shared by
  // every extension context including content scripts, and the manifest already asks for "storage".
  const SCRAPE_KEY = "plst.scrape";
  const DEFAULT_SCRAPE = { stepWaitMs: 1500, retryWaitMs: 1000 };
  const SCRAPE_MAX_MS = 10000;
  // No login yet: the plst web app just switches a user id, so the popup does the same.
  const DEFAULT_USER_ID = 1;
  // Same rule as cli.ts and job.ejs: a non-perfect score is never "just fine", it wants a human look.
  const PERFECT = 0.9995;
  const POLL_MS = 2000;
  const LEGACY_KEYS = { "plst.server": "mush.server", "plst.userId": "yaum.userId" };

  let accumulated = [];
  let links = [];
  let pollTimer = null;
  // Ships the log on a timer while the popup is open; the interval dies with the page.
  let shipTimer = null;

  // ---------------------------------------------------------- scan-in-progress UI
  //
  // While the walk runs: "Scan tab" is swapped for pause/stop icons, and everything that acts on
  // scan RESULTS is disabled — the results are still moving (grow() replaces them wholesale), and
  // importing a half-collected list builds a half playlist. One function owns that logic so the
  // "empty results" and "scanning" reasons can never disagree with each other.
  let scanning = false;
  let paused = false;
  const syncButtons = () => {
    const noResults = accumulated.length === 0;
    importBtn.disabled = scanning || noResults;
    convertBtn.disabled = scanning || noResults;
    copyBtn.disabled = scanning || noResults;
    copyLinksBtn.disabled = scanning || noResults;
  };
  const setScanning = (on) => {
    scanning = on;
    paused = false;
    if (pauseScan) {
      pauseScan.textContent = "⏸";
      pauseScan.title = "pause the walk";
    }
    scanControls?.classList.toggle("hidden", !on);
    btn.classList.toggle("hidden", on);
    syncButtons();
  };
  const sendToScanTab = (type) =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => {
      if (t?.id) chrome.tabs.sendMessage(t.id, { type }).catch(() => {});
    });

  const setMsg = (s) => {
    msg.textContent = s;
    plstLog.info("popup", "status", { text: s });
  };
  const show = (el, on) => el.classList.toggle("hidden", !on);
  const base = () => serverInput.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER;
  const userId = () => {
    const n = Number(userIdInput.value);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_USER_ID;
  };

  // Every network call goes through here, so a failure always has the URL, the status and the
  // body that came back. "It did nothing" is nearly always one of these four facts.
  const call = async (url, init) => {
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // A network-level throw (DNS, refused connection, blocked by permissions) never produces a
      // status, so log the cause explicitly — this is the "is the server even running" branch.
      plstLog.error("popup", "fetch failed before any response", {
        url,
        method: init?.method ?? "GET",
        server: base(),
        error: String(e?.message ?? e),
      });
      throw e;
    }
    const ms = Date.now() - started;
    const body = await res.text();
    if (res.ok) {
      plstLog.info("popup", `${init?.method ?? "GET"} ${new URL(url).pathname}`, {
        status: res.status,
        ms,
      });
    } else {
      plstLog.error("popup", `${init?.method ?? "GET"} ${new URL(url).pathname} failed`, {
        status: res.status,
        ms,
        // The server sends plain text for every deliberate 4xx, so this is the reason.
        body: body.slice(0, 500),
      });
    }
    if (!res.ok) throw new Error(body.trim() || `HTTP ${res.status}`);
    // url is the post-redirect URL, which is the only place a 303's target is visible cross-origin.
    return { text: body, url: res.url };
  };

  // Storage keys were renamed mush/yaum -> plst; fall back to the old names so an existing install
  // keeps the server URL and user it had already chosen instead of reverting to the defaults.
  const stored = (key, dflt) => localStorage.getItem(key) ?? localStorage.getItem(LEGACY_KEYS[key] ?? "") ?? dflt;
  serverInput.value = stored("plst.server", DEFAULT_SERVER);
  userIdInput.value = stored("plst.userId", String(DEFAULT_USER_ID));

  const grow = (items) => {
    accumulated = items;
    out.value = JSON.stringify(accumulated, null, 2);
    out.scrollTop = out.scrollHeight;
    syncButtons();
    // Both next steps matter and neither one happens on its own, so name both. Leaving out the
    // import here is what makes a successful scan look like it should already be in the database.
    if (accumulated.length) {
      setMsg(
        `✓ ${items.length} tracks (dedup'd), read from the page — not saved yet. ` +
        `Press "2 · Import into my library" to store them, or "3 · Convert with plst" for links.`
      );
    }
  };

  /* ---------- plst conversion ---------- */

  // application/x-www-form-urlencoded is CORS-safelisted, so there is no preflight; it is also what
  // @fastify/formbody on the server already parses.
  const postForm = async (path, fields) => {
    const body = new URLSearchParams(fields).toString();
    return await call(base() + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "follow",
    });
  };

  // An https:// host outside the static host_permissions needs a grant before fetch will reach it.
  const ensurePermission = async (url) => {
    const origin = new URL(url).origin + "/*";
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (granted) {
      plstLog.info("popup", "host permission already granted", { origin });
      return true;
    }
    // A denied prompt is silent in the UI otherwise, and it is the reason a fetch that works in a
    // terminal fails here.
    plstLog.warn("popup", "host permission not granted, prompting", { origin });
    const ok = await chrome.permissions.request({ origins: [origin] });
    plstLog.info("popup", "host permission result", { origin, granted: ok });
    return ok;
  };

  // ---------------------------------------------------------------- backend identity check
  //
  // Ask the configured backend what it is, on every popup open. This is not a health badge for
  // its own sake: "I scanned and nothing happened" is usually a popup pointed at the wrong server,
  // and a version string is what makes that visible in the log before anyone has to guess. It is
  // deliberately slow-tolerant (see GET_UPDATES_TIMEOUT_MS) and never blocks the popup.
  const checkBackend = async () => {
    const url = `${base()}/api/get-updates`;
    const started = Date.now();
    if (serverStatus) serverStatus.textContent = `checking ${base()} — a cold start can take up to ${GET_UPDATES_TIMEOUT_MS / 1000}s…`;
    try {
      const { text } = await call(url, { signal: AbortSignal.timeout(GET_UPDATES_TIMEOUT_MS) });
      const ms = Date.now() - started;
      const data = JSON.parse(text || "{}");
      plstLog.info("popup", "backend answered /api/get-updates", {
        server: base(),
        ms,
        version: data?.version ?? null,
        projectId: data?.project_id ?? null,
      });
      if (serverStatus) {
        serverStatus.textContent =
          `✓ ${base()} — version ${data?.version ?? "(none)"} · ${data?.project_id ?? "?"} · ${ms}ms`;
      }
    } catch (e) {
      const ms = Date.now() - started;
      // call() already logged the failure with url and body; this is the on-screen half.
      plstLog.warn("popup", "backend check failed", {
        server: base(),
        ms,
        error: String(e?.message ?? e),
      });
      if (serverStatus) serverStatus.textContent = `✗ ${base()} — ${String(e?.message ?? e)} · ${ms}ms`;
    }
  };

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const render = (job, items) => {
    const s = (job.summary_json ? JSON.parse(job.summary_json) : [{}])[0] || {};
    sumEl.textContent =
      `job ${job.id} · ${job.status} · ${job.processed}/${job.total} tracks\n` +
      `matched ${s.matched ?? 0}  uncertain ${s.uncertain ?? 0}  not found ${s.not_found ?? 0}` +
      (s.skipped_dup ? `  dups ${s.skipped_dup}` : "");
    links = items.filter((i) => i.yt_video_id)
      .map((i) => `https://music.youtube.com/watch?v=${i.yt_video_id}`);
    resEl.textContent = "";
    for (const it of items) {
      const li = document.createElement("li");
      const flag = it.score != null && it.score > 0 && it.score < PERFECT;
      const name = it.yt_video_id
        ? `<a href="https://music.youtube.com/watch?v=${it.yt_video_id}" target="_blank">${escapeHtml(it.yt_artist)} — ${escapeHtml(it.yt_title)}</a>`
        : `<span class="no">— nothing found —</span>`;
      li.innerHTML =
        `${escapeHtml(it.src_artist)} — ${escapeHtml(it.src_title)}<br>` +
        `↳ ${name} <span class="meta">${it.score != null ? it.score.toFixed(2) : ""}` +
        `${flag ? ' <span class="flag">⚠ review</span>' : ""} · ${escapeHtml(it.status)}</span>`;
      resEl.appendChild(li);
    }
    show(sumEl, true);
    show(resEl, true);
    show(copyLinksBtn, links.length > 0);
    openJob.href = `${base()}/job/${job.id}`;
    openJob.classList.remove("hidden");
  };

  const poll = async (id) => {
    try {
      const data = JSON.parse((await call(`${base()}/job/${id}?format=json`)).text);
      setMsg(`matching on the server… ${data.job.processed}/${data.job.total} tracks`);
      if (data.job.status === "done" || data.job.status === "failed") {
        render(data.job, data.items ?? []);
        const bad = (data.items ?? []).filter((i) => i.score != null && i.score > 0 && i.score < PERFECT).length;
        setMsg(
          `✓ ${data.job.status} — ${links.length} links` +
          (bad ? `, ${bad} flagged ⚠ for review (a wrong-but-confident match must never hide).` : ".")
        );
        return;
      }
      pollTimer = setTimeout(() => poll(id), POLL_MS);
    } catch (e) {
      setMsg(`✗ ${String(e?.message ?? e)} — the job ${id} may still be running on the server.`);
    }
  };

  convertBtn.addEventListener("click", async () => {
    clearTimeout(pollTimer);
    convertBtn.disabled = true;
    setMsg("Sending tracks to plst…");
    try {
      if (!(await ensurePermission(base()))) throw new Error("permission denied for this server");
      const { url } = await postForm("/migrate", { mode: "json", source: JSON.stringify(accumulated) });
      const id = /\/job\/([A-Za-z0-9_-]+)/.exec(url ?? "")?.[1];
      if (!id) throw new Error(`no job id in ${res.url}`);
      setMsg("accepted — waiting for the server…");
      await poll(id);
    } catch (e) {
      setMsg(`✗ ${String(e?.message ?? e)} — is the plst server running at ${base()}?`);
    } finally {
      convertBtn.disabled = accumulated.length === 0;
    }
  });

  copyLinksBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(links.join("\n"));
      setMsg(`✓ ${links.length} YouTube Music links copied.`);
    } catch (e) {
      setMsg("✗ " + String(e?.message ?? e));
    }
  });

  /* ---------- plst library import ---------- */

  // Unlike /migrate this needs a JSON body, so it does preflight: that is why the app server
  // carries CORS headers and the popup asks for the host permission first.
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    setMsg("Importing into the plst library…");
    // Logged before the request: if the popup is closed mid-flight, the log still shows that an
    // import was ATTEMPTED, which is what makes "I clicked it and nothing happened" answerable.
    plstLog.info("popup", "import requested", {
      server: base(),
      userId: userId(),
      tracks: accumulated.length,
    });
    try {
      if (!(await ensurePermission(base()))) throw new Error("permission denied for this server");
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const body = JSON.stringify({
        userId: userId(),
        pageUrl: tab?.url ?? null,
        label: tab?.title ?? null,
        tracks: accumulated,
      });
      const { text } = await call(`${base()}/api/library/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const r = JSON.parse(text);
      void globalThis.plstShip.ship().then(showShipStatus);
      plstLog.info("popup", "import accepted", {
        importId: r.importId,
        newCount: r.newCount,
        dupCount: r.dupCount,
        skippedCount: r.skippedCount,
        pendingImports: r.pendingImports,
        user: r.user?.username,
      });
      setMsg(
        `✓ import #${r.importId} — ${r.newCount} new, ${r.dupCount} already in the library` +
        (r.skippedCount ? `, ${r.skippedCount} skipped` : "") +
        `. Open the web app → Imports to review and turn it into a playlist.`
      );
    } catch (e) {
      plstLog.error("popup", "import failed", { error: String(e?.message ?? e), server: base() });
    void globalThis.plstShip.ship().then(showShipStatus);
      setMsg(`✗ ${String(e?.message ?? e)} — is the plst server running at ${base()}?`);
    } finally {
      importBtn.disabled = accumulated.length === 0;
    }
  });

  saveServerBtn?.addEventListener("click", () => {
    const v = base();
    serverInput.value = v;
    localStorage.setItem("plst.server", v);
    setMsg(`✓ server URL saved: ${v}`);
    void checkBackend();
  });

  // Quick-set: the button is the user gesture, so this is also where an https:// host outside the
  // static permissions gets its grant — asking later, from inside an import, is the same request
  // with more at stake and a failure that reads like a server bug.
  for (const preset of QUICK_SETS) {
    document.getElementById(preset.id)?.addEventListener("click", async () => {
      serverInput.value = preset.url;
      localStorage.setItem("plst.server", preset.url);
      let granted = null;
      try {
        granted = await ensurePermission(preset.url);
      } catch (e) {
        plstLog.warn("popup", "permission check threw", { url: preset.url, error: String(e?.message ?? e) });
      }
      setMsg(`✓ server URL saved: ${preset.url}${granted === false ? " (permission NOT granted — requests to it will fail)" : ""}`);
      void checkBackend();
    });
  }

  userIdInput?.addEventListener("change", () => {
    const v = userId();
    userIdInput.value = String(v);
    localStorage.setItem("plst.userId", String(v));
    setMsg(`✓ importing as user ${v} (${userId() === DEFAULT_USER_ID ? "the default" : "set in this popup"}).`);
  });

  /* ---------- scrape intervals (settings tab) ---------- */

  // Clamped on the way in and out: a hand-edited or out-of-range stored value must never be able
  // to freeze a scan with an absurd wait, nor silently break it with a negative one.
  const clampMs = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(SCRAPE_MAX_MS, Math.max(0, n));
  };

  // Read settings, falling back to the defaults for anything missing or bad.
  const readScrape = async () => {
    const { [SCRAPE_KEY]: saved } = await chrome.storage.local.get(SCRAPE_KEY);
    return {
      stepWaitMs: clampMs(saved?.stepWaitMs) ?? DEFAULT_SCRAPE.stepWaitMs,
      retryWaitMs: clampMs(saved?.retryWaitMs) ?? DEFAULT_SCRAPE.retryWaitMs,
    };
  };

  const showScrapeStatus = (s) => {
    if (scrapeStatus) {
      scrapeStatus.textContent = `saved — step wait ${s.stepWaitMs}ms, collect retry ${s.retryWaitMs}ms`;
    }
  };

  const saveScrape = async () => {
    const s = {
      stepWaitMs: clampMs(stepWaitInput?.value) ?? DEFAULT_SCRAPE.stepWaitMs,
      retryWaitMs: clampMs(retryWaitInput?.value) ?? DEFAULT_SCRAPE.retryWaitMs,
    };
    await chrome.storage.local.set({ [SCRAPE_KEY]: s });
    plstLog.info("popup", "scrape intervals saved", s);
    showScrapeStatus(s);
    return s;
  };

  stepWaitInput?.addEventListener("change", () => void saveScrape());
  retryWaitInput?.addEventListener("change", () => void saveScrape());

  // Fill the inputs from storage, so reopening the panel shows what is actually in effect.
  void readScrape().then((s) => {
    if (stepWaitInput) stepWaitInput.value = String(s.stepWaitMs);
    if (retryWaitInput) retryWaitInput.value = String(s.retryWaitMs);
    showScrapeStatus(s);
  });

  /* ---------- tabs ---------- */

  // Three top-level panels, scan is the default. Every id used elsewhere still exists exactly once,
  // so scan/import/convert and all the log wiring keep working whichever panel is on screen.
  const tabButtons = [...document.querySelectorAll('.tabs [role="tab"]')];
  const panels = {
    scan: document.getElementById("panel-scan"),
    settings: document.getElementById("panel-settings"),
    logs: document.getElementById("panel-logs"),
  };
  const selectTab = (name) => {
    if (!panels[name]) return;
    for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.panel === name));
    for (const [k, el] of Object.entries(panels)) el?.classList.toggle("active", k === name);
    plstLog.info("popup", "tab selected", { tab: name });
  };
  for (const b of tabButtons) b.addEventListener("click", () => selectTab(b.dataset.panel));

  chrome.runtime.onMessage.addListener((m) => {
    // The content script's own trace, relayed into this buffer so a scan that failed inside the
    // page is visible from the popup's log.
    if (m?.type === "SCAN_LOG") {
      const send = m.level === "error" ? plstLog.error : m.level === "warn" ? plstLog.warn : plstLog.info;
      send("page", m.msg, m.data);
      return;
    }
    if (m?.type !== "SCAN_STEP") return;
    for (const nm of m.names ?? []) log.value += `parsed "${nm}"\n`;
    log.scrollTop = log.scrollHeight;
    grow(m.items);
  });

  /**
   * The content script is injected when a page LOADS — reloading the extension does not
   * re-inject it into already-open tabs, and the previously injected copy is ORPHANED (its
   * extension context died with the old worker). So sendMessage from the fresh extension fails
   * with "Receiving end does not exist" even on a perfect music.yandex page. The fix is
   * mechanical: reload the tab (a fresh load injects a fresh script) and scan again. Reported
   * live 2026-10-13, minutes after the 0.5.1 reload.
   */
  const RELOAD_WAIT_CAP_MS = 15000;
  const reloadAndWait = (tabId) =>
    new Promise((resolve, reject) => {
      let timer = null;
      const stop = (fn, value) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        fn(value);
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') stop(resolve, true);
      };
      chrome.tabs.onUpdated.addListener(listener);
      // false = gave up waiting (a slow page is not an error, just too late for this click).
      timer = setTimeout(() => stop(resolve, false), RELOAD_WAIT_CAP_MS);
      chrome.tabs.reload(tabId).catch((e) => stop(reject, e));
    });
  // tab.url is only readable for hosts we hold permission for — the yandex hosts were added to
  // host_permissions exactly so this check can exist. Without a confirmed yandex URL the old
  // hint stays: blindly reloading whatever tab the user is on would be worse than the error.
  const isYandexTab = (tab) => Boolean(tab?.url && /https:\/\/music\.yandex\.(ru|kz)\//.test(tab.url));
  const sendScan = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'SCAN' });

  btn.addEventListener("click", async () => {
    setScanning(true);
    setMsg("Scanning the rendered page in your tab…");
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      plstLog.info("popup", "scan requested", { tabId: tab.id, url: tab.url?.slice(0, 200) });
      let res;
      try {
        res = await sendScan(tab.id);
      } catch (firstErr) {
        const firstMsg = String(firstErr?.message ?? firstErr);
        if (!/Receiving end does not exist/i.test(firstMsg) || !isYandexTab(tab)) throw firstErr;
        plstLog.warn("popup", "content script missing on a yandex tab — reloading it and retrying", {
          tabId: tab.id,
          url: tab.url?.slice(0, 200),
          error: firstMsg,
        });
        setMsg("The scanner is not attached to this tab yet — reloading it and retrying…");
        const completed = await reloadAndWait(tab.id);
        if (!completed) throw new Error("the tab did not finish reloading in time — press Scan again");
        // "complete" fires just before the content scripts run at document_idle; give it a beat.
        await new Promise((r) => setTimeout(r, 400));
        plstLog.info("popup", "scan retry after tab reload", { tabId: tab.id });
        res = await sendScan(tab.id);
      }
      if (!res?.ok) throw new Error(res?.error ?? "no reply");
      grow(res.data.tracks);
      // grow() already set the right next-step message; don't overwrite it with a vaguer one.
      if (!res.data.count) setMsg("✗ no tracks found on this page — is the tracklist rendered?");
    } catch (e) {
      // "Receiving end does not exist" means the content script is not in that tab at all — the
      // single most common scan failure, so it gets its own line in the log.
      const msgText = String(e?.message ?? e);
      void globalThis.plstShip.ship().then(showShipStatus);
      plstLog.error("popup", "scan failed", {
        error: msgText,
        hint: /Receiving end does not exist/i.test(msgText)
          ? "the content script is not in that tab (not a music.yandex.ru/.kz page?)"
          : undefined,
      });
      setMsg(`✗ ${msgText} — make sure this tab is a music.yandex page.`);
    } finally {
      setScanning(false);
    }
  });

  // Pause toggles the walk's gate in the content script and the icon here; the panel is the only
  // place that knows both, so the toggle lives entirely in this file.
  pauseScan?.addEventListener("click", () => {
    paused = !paused;
    pauseScan.textContent = paused ? "▶" : "⏸";
    pauseScan.title = paused ? "resume the walk" : "pause the walk";
    sendToScanTab(paused ? "SCAN_PAUSE" : "SCAN_RESUME");
    setMsg(paused ? "⏸ paused — the walk holds where it is." : "▶ resumed.");
  });

  const stopNow = () => {
    sendToScanTab("SCAN_STOP");
    log.value += "[stopped by you] — the walk halts on its next scroll check.\n";
    setMsg("Stop requested.");
  };
  stopScanTop?.addEventListener("click", stopNow);

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.value || "[]");
      setMsg(`✓ JSON copied (${accumulated.length} tracks).`);
    } catch (e) {
      setMsg("✗ " + String(e?.message ?? e));
    }
  });

  /* ---------- diagnostics log ---------- */

  // Loaded from storage first so a trace from a previous popup session is already on screen —
  // the whole point is that the evidence outlives the surface that produced it.
  plstLog.init().then((entries) => {
    if (entries.length) {
      diaglog.value = plstLog.text();
      diaglog.scrollTop = diaglog.scrollHeight;
    }
    // A boot line, so the log records that the popup was opened at all and — crucially — WHICH
    // server and user it resolved to. A report of "I clicked import and nothing happened" is
    // unanswerable without this: the usual cause is a popup pointed at the wrong server.
    plstLog.info("popup", "opened", {
      version: chrome.runtime.getManifest().version,
      server: base(),
      userId: userId(),
      // From storage, not the inputs: this is what a previous session actually chose.
      savedServer: stored("plst.server", null),
      savedUserId: stored("plst.userId", null),
      restoredEntries: entries.length,
      extensionId: chrome.runtime.id,
    });
    // Ship what is already here (including the line just written above), then start the timer.
    void globalThis.plstShip.ship().then(showShipStatus);
    shipTimer = setInterval(() => void globalThis.plstShip.ship().then(showShipStatus), 45_000);
    // pagehide rather than unload: keepalive fetches are the only ones allowed to finish on close.
    globalThis.addEventListener("pagehide", () => void globalThis.plstShip.ship({ force: true }));
    // Which backend is this popup actually talking to? Fire-and-forget: it must never delay or
    // break the scan/import buttons, it only fills #serverStatus and writes one log line.
    void checkBackend();
  });
  // Re-render as things happen, throttled: the walk logs per step and a textarea rewrite per
  // entry would be the slowest thing in the popup.
  let logPaint = null;
  const repaint = () => {
    if (logPaint) return;
    logPaint = setTimeout(() => {
      logPaint = null;
      const atBottom = diaglog.scrollTop + diaglog.clientHeight >= diaglog.scrollHeight - 8;
      diaglog.value = plstLog.text();
      if (atBottom) diaglog.scrollTop = diaglog.scrollHeight;
    }, 250);
  };
  const origInfo = plstLog.info;
  plstLog.info = (...a) => { const r = origInfo.apply(plstLog, a); repaint(); return r; };
  const origWarn = plstLog.warn;
  plstLog.warn = (...a) => { const r = origWarn.apply(plstLog, a); repaint(); return r; };
  const origError = plstLog.error;
  plstLog.error = (...a) => { const r = origError.apply(plstLog, a); repaint(); return r; };

  // ---------------------------------------------------------------- ship to backend
  //
  // The log above dies with this browser profile. Shipping it to the backend is what makes it
  // checkable later ("the extension really did log nothing") instead of a claim. Automatic on open
  // (so leftovers from a previous session go out) and after a scan or import (so the interesting
  // part is not left sitting in storage), plus this button for "send it now".
  const showShipStatus = () => {
    if (logShip) logShip.textContent = globalThis.plstShip?.describe?.() ?? "shipping unavailable";
  };
  shipLogBtn?.addEventListener("click", async () => {
    showShipStatus();
    await globalThis.plstShip.ship({ force: true });
    showShipStatus();
  });

  copyLogBtn?.addEventListener("click", async () => {
    try {
      await plstLog.flush();
      await navigator.clipboard.writeText(plstLog.text() || "(log is empty)");
      setMsg("✓ logs copied — paste them into the bug report.");
    } catch (e) {
      setMsg("✗ " + String(e?.message ?? e));
    }
  });
  openLogBtn?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") });
  });
  clearLogBtn?.addEventListener("click", () => {
    plstLog.clear();
    diaglog.value = "–– log cleared ––";
  });

  stopBtn?.addEventListener("click", stopNow);
})();