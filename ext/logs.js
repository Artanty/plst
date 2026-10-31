/**
 * Renders the extension log buffer (see log.js) as a filterable table.
 *
 * This lives in its own file rather than inline in logs.html on purpose: the MV3 default CSP is
 * script-src 'self', which refuses inline scripts outright — an inline block here is silently
 * dead code, and the page renders an empty table with nothing in the console to explain it.
 */
(() => {
  const rows = document.getElementById("rows");
  const empty = document.getElementById("empty");
  const meta = document.getElementById("meta");
  const levelSel = document.getElementById("level");
  const find = document.getElementById("find");
  const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

  const all = () => plstLog.entries();

  const filtered = () => {
    const want = levelSel.value;
    const min = want === "all" ? 0 : RANK[want];
    const q = find.value.trim().toLowerCase();
    return all().filter((e) => {
      if (RANK[e.level] < min) return false;
      if (!q) return true;
      return (e.msg + " " + e.scope + " " + (e.data ? JSON.stringify(e.data) : ""))
        .toLowerCase()
        .includes(q);
    });
  };

  const paint = () => {
    const shown = filtered();
    rows.textContent = "";
    // Newest first: the interesting line is almost always the last thing that happened.
    for (const e of shown.slice().reverse()) {
      const tr = document.createElement("tr");
      if (e.level === "warn" || e.level === "error") tr.className = e.level;
      for (const [text, cls] of [
        [e.t, "t"],
        [e.level, "lv"],
        [e.scope, "sc"],
        [e.msg, ""],
        [e.data === undefined ? "" : JSON.stringify(e.data), "d"],
      ]) {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      rows.appendChild(tr);
    }
    empty.hidden = shown.length > 0;
    meta.textContent = `${shown.length} shown / ${all().length} kept`;
  };

  const copy = async (text, what) => {
    try {
      await plstLog.flush();
      await navigator.clipboard.writeText(text || "(nothing to copy)");
      const btn = what === "all" ? document.getElementById("copy") : document.getElementById("copyFiltered");
      const was = btn.textContent;
      btn.textContent = "✓ copied";
      setTimeout(() => { btn.textContent = was; }, 1200);
    } catch (e) {
      alert("clipboard blocked: " + String(e?.message ?? e));
    }
  };

  document.getElementById("copy").addEventListener("click", () => copy(plstLog.text(), "all"));
  document.getElementById("copyFiltered").addEventListener("click", () => {
    copy(filtered().map((e) => {
      const d = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
      return `${e.t} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}${d}`;
    }).join("\n"), "filtered");
  });
  document.getElementById("refresh").addEventListener("click", async () => {
    await plstLog.init();
    paint();
  });
  document.getElementById("clear").addEventListener("click", () => {
    plstLog.clear();
    paint();
  });
  levelSel.addEventListener("change", paint);
  find.addEventListener("input", paint);

  plstLog.init().then(paint);
  // Cheap poll: the log is written by the popup and the content script, and this page is not
  // notified when they do. 1s is invisible to a human reading a log.
  setInterval(async () => {
    await plstLog.init();
    paint();
  }, 1000);
})();
