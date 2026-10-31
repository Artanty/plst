// The extension is side-panel-ONLY: there is no popup any more, so clicking the toolbar icon must
// open the panel instead of doing nothing. This is the whole reason a service worker exists here —
// chrome.sidePanel.setPanelBehavior() is only callable from a service worker or an extension page,
// and once manifest.json drops action.default_popup there is no extension page until the panel
// opens.
//
// Two mechanisms, deliberately: setPanelBehavior arms a PERSISTED preference (Chrome remembers it
// across SW restarts and browser restarts), and action.onClicked -> sidePanel.open() is the live
// fallback. They never both run for one click — Chrome docs: onClicked does NOT fire while
// openPanelOnActionClick is armed — so onClicked fires exactly in the failure mode this guards
// (the preference never got set, or was lost). action.onClicked is a documented valid user
// gesture for sidePanel.open(). Either mechanism live, the click opens the panel.
//
// Both paths log into the same chrome.storage.local ring buffer the panel shows and ships
// (log.js is DOM-free and storage-guarded, so importScripts works here). A worker that logs its
// own birth, its arm result, and every click it sees is what makes "clicking does nothing"
// answerable from logs instead of from guesses.

let logOk = false;
try {
  importScripts("log.js");
  logOk = typeof globalThis.plstLog !== "undefined";
} catch {
  // A missing log.js must not kill the worker — the panel-opening behaviour still has to work.
}
const trace = (level, msg, data) => {
  if (logOk) globalThis.plstLog[level]?.("sw", msg, data);
  // Console too: chrome://extensions' service-worker "inspect" shows it even when storage writes
  // are the thing that failed.
  try {
    console[level === "error" ? "error" : "log"](`plst sw: ${msg}`, data ?? "");
  } catch {
    /* console can be unavailable in odd contexts */
  }
};

const arm = () => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => trace("info", "panel behavior armed — toolbar click opens the side panel"))
    .catch((e) => {
      // The reason lands in the buffer, so a future "click does nothing" names its own cause.
      trace("error", "setPanelBehavior failed — falling back to action.onClicked", String(e?.message ?? e));
    });
};

// Fires on install AND on every SW wake (install/update, browser start, and the idle-restart MV3
// does after ~30s). setPanelBehavior is idempotent, so re-asserting on every wake is self-healing.
arm();
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);

chrome.action.onClicked.addListener((tab) => {
  trace("info", "action click — opening side panel directly", { windowId: tab?.windowId });
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((e) => trace("error", "sidePanel.open failed", String(e?.message ?? e)));
});

trace("info", "service worker started", { version: chrome.runtime.getManifest().version });
