/**
 * Pin Tab Extension — Safari-style global pinned tabs for Chromium/Brave.
 * Keeps an ordered URL set in chrome.storage.local and restores pins into
 * every normal window until the user unpins or closes a pinned tab while
 * the browser is still open. Closing the last window does not clear the set.
 */

const STORAGE_KEY = "pinnedUrls";
const LOG_PREFIX = "[Pin Tab Extension]";

/** In-memory guard: ignore pin/unpin noise while we restore programmatically. */
let restoring = false;

/**
 * Set when the last window is gone / session is ending so late unpin/remove
 * events cannot wipe chrome.storage.local.
 */
let sessionEnding = false;

/** tabId → url for pinned tabs (needed because onRemoved has no tab payload). */
const pinnedTabCache = new Map();

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

/** Restricted schemes that extensions cannot open. */
function isRestrictedUrl(url) {
  if (!url || typeof url !== "string") return true;
  try {
    const u = new URL(url);
    const scheme = u.protocol.toLowerCase();
    return (
      scheme === "chrome:" ||
      scheme === "chrome-extension:" ||
      scheme === "chrome-search:" ||
      scheme === "chrome-untrusted:" ||
      scheme === "brave:" ||
      scheme === "edge:" ||
      scheme === "about:" ||
      scheme === "devtools:" ||
      scheme === "view-source:" ||
      scheme === "data:" ||
      scheme === "blob:" ||
      scheme === "file:"
    );
  } catch {
    return true;
  }
}

function pickUsableUrl(tab) {
  if (!tab) return null;
  for (const candidate of [tab.url, tab.pendingUrl]) {
    if (candidate && !isRestrictedUrl(candidate)) return candidate;
  }
  return null;
}

async function getPinnedUrls() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const list = result[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function setPinnedUrls(urls) {
  await chrome.storage.local.set({ [STORAGE_KEY]: urls });
  log("storage updated:", urls);
}

/** Add URL to the ordered list if not already present (dedupe by URL). */
async function addPinnedUrl(url) {
  if (!url || isRestrictedUrl(url)) {
    warn("skip save: restricted or empty URL", url);
    return;
  }
  const urls = await getPinnedUrls();
  if (urls.includes(url)) {
    log("save skipped (already stored):", url);
    return;
  }
  urls.push(url);
  await setPinnedUrls(urls);
  log("saved pin:", url);
}

async function removePinnedUrl(url, reason) {
  if (!url) return;
  const urls = await getPinnedUrls();
  const next = urls.filter((u) => u !== url);
  if (next.length === urls.length) {
    log("remove skipped (not in storage):", url, reason || "");
    return;
  }
  await setPinnedUrls(next);
  log("removed pin:", url, reason || "");
}

async function resolveTabUrl(tabId, tab) {
  const fromEvent = pickUsableUrl(tab);
  if (fromEvent) return fromEvent;
  try {
    const full = await chrome.tabs.get(tabId);
    return pickUsableUrl(full);
  } catch (err) {
    warn("tabs.get failed for", tabId, err);
    return null;
  }
}

/** True when at least one normal window still exists (browser not shutting down). */
async function browserStillOpen() {
  if (sessionEnding) return false;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return windows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure each saved URL is present as a pinned tab in the given window,
 * in stored order. Dedupe by URL within the window; skip restricted URLs.
 */
async function restorePinsInWindow(windowId) {
  if (windowId == null) return;

  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || win.type !== "normal") {
    log("restore skip: window missing or not normal", windowId, win?.type);
    return;
  }

  const saved = await getPinnedUrls();
  log("restore window", windowId, "saved=", saved);
  if (saved.length === 0) return;

  restoring = true;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const pinnedByUrl = new Map();
    for (const tab of tabs) {
      if (tab.pinned && tab.url && !pinnedByUrl.has(tab.url)) {
        pinnedByUrl.set(tab.url, tab);
      }
    }

    let insertIndex = 0;
    for (const url of saved) {
      if (isRestrictedUrl(url)) {
        warn("Skipping restricted URL on restore:", url);
        continue;
      }

      const existing = pinnedByUrl.get(url);
      if (existing) {
        if (existing.index !== insertIndex) {
          try {
            await chrome.tabs.move(existing.id, { index: insertIndex });
          } catch (err) {
            warn("Failed to reorder pin:", url, err);
          }
        }
        if (existing.id != null) {
          pinnedTabCache.set(existing.id, { url });
        }
        insertIndex += 1;
        continue;
      }

      // Prefer pinning an existing unpinned tab with the same URL over duplicating.
      const unpinnedMatch = tabs.find(
        (t) => !t.pinned && t.url === url && t.id != null
      );
      if (unpinnedMatch) {
        try {
          await chrome.tabs.update(unpinnedMatch.id, { pinned: true });
          await chrome.tabs.move(unpinnedMatch.id, { index: insertIndex });
          pinnedTabCache.set(unpinnedMatch.id, { url });
          log("restore: pinned existing tab", url);
        } catch (err) {
          warn("Failed to pin existing tab:", url, err);
        }
        insertIndex += 1;
        continue;
      }

      try {
        const created = await chrome.tabs.create({
          windowId,
          url,
          pinned: true,
          active: false,
          index: insertIndex,
        });
        if (created.id != null) {
          pinnedTabCache.set(created.id, { url });
        }
        log("restore: created pinned tab", url);
        insertIndex += 1;
      } catch (err) {
        warn("Failed to create pinned tab:", url, err);
      }
    }
  } finally {
    // Let create/update events settle before we listen for user pin changes again.
    setTimeout(() => {
      restoring = false;
      log("restore guard cleared for window", windowId);
    }, 750);
  }
}

async function restorePinsInAllNormalWindows() {
  sessionEnding = false;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  log("restore all: normal windows=", windows.length);
  if (windows.length === 0) {
    warn("restore all: no windows yet (will retry if scheduled)");
    return false;
  }
  for (const win of windows) {
    await restorePinsInWindow(win.id);
  }
  return true;
}

/**
 * Startup/session restore races: windows or tabs may not exist yet when
 * onStartup fires. Retry a few times.
 */
function scheduleRestoreRetries(reason) {
  log("schedule restore retries:", reason);
  const delays = [0, 500, 1500, 3000, 6000];
  for (const ms of delays) {
    setTimeout(() => {
      restorePinsInAllNormalWindows().catch((err) =>
        warn("restore retry failed:", err)
      );
    }, ms);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // If a pinned tab's URL commits after pin (or pendingUrl resolves), persist it.
  if (
    tab.pinned &&
    (changeInfo.url || changeInfo.status === "complete") &&
    !restoring &&
    !sessionEnding
  ) {
    const url = await resolveTabUrl(tabId, tab);
    if (url) {
      pinnedTabCache.set(tabId, { url });
      if (changeInfo.url) {
        await addPinnedUrl(url);
      }
    }
  } else if (tab.pinned && (changeInfo.url || tab.url)) {
    const url = changeInfo.url || tab.url;
    if (url && !isRestrictedUrl(url)) {
      pinnedTabCache.set(tabId, { url });
    }
  }

  if (changeInfo.pinned === undefined) return;
  if (restoring) {
    log("ignore pin change while restoring", tabId, changeInfo.pinned);
    return;
  }
  if (sessionEnding) {
    log("ignore pin change while session ending", tabId, changeInfo.pinned);
    return;
  }

  if (changeInfo.pinned === true) {
    const pinUrl = await resolveTabUrl(tabId, tab);
    if (pinUrl) {
      pinnedTabCache.set(tabId, { url: pinUrl });
      await addPinnedUrl(pinUrl);
    } else {
      warn(
        "pin event but URL not ready yet; will save on next URL update",
        tabId,
        tab?.url,
        tab?.pendingUrl
      );
      pinnedTabCache.set(tabId, { url: null });
    }
  } else if (changeInfo.pinned === false) {
    // Window teardown can emit unpin before onRemoved. Do not clear storage
    // unless the browser is still open with a live session.
    if (!(await browserStillOpen())) {
      log("ignore unpin: browser not open / session ending", tabId);
      pinnedTabCache.delete(tabId);
      return;
    }
    // If the tab is already gone, this is teardown — not a user unpin.
    let stillExists = true;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      stillExists = false;
    }
    if (!stillExists) {
      log("ignore unpin: tab already gone (teardown)", tabId);
      pinnedTabCache.delete(tabId);
      return;
    }

    const cached = pinnedTabCache.get(tabId);
    pinnedTabCache.delete(tabId);
    const unpinUrl = cached?.url || (await resolveTabUrl(tabId, tab));
    if (unpinUrl) {
      await removePinnedUrl(unpinUrl, "user unpin");
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const cached = pinnedTabCache.get(tabId);
  pinnedTabCache.delete(tabId);

  if (!cached?.url) {
    return;
  }
  if (restoring) {
    log("ignore remove while restoring", cached.url);
    return;
  }

  // Closing a whole window (including session end) must not clear the set.
  if (removeInfo.isWindowClosing || sessionEnding) {
    log(
      "preserve pin on window/session close:",
      cached.url,
      "isWindowClosing=",
      removeInfo.isWindowClosing
    );
    return;
  }

  if (!(await browserStillOpen())) {
    log("preserve pin: no windows left:", cached.url);
    return;
  }

  await removePinnedUrl(cached.url, "pinned tab closed");
});

chrome.windows.onCreated.addListener((win) => {
  sessionEnding = false;
  if (win.type !== "normal") {
    log("window created (non-normal), skip", win.type);
    return;
  }
  log("window created, restoring", win.id);
  // Defer slightly so the window has a tab strip; also retry for session restore.
  scheduleRestoreRetries(`windows.onCreated:${win.id}`);
});

chrome.windows.onRemoved.addListener(async () => {
  try {
    const left = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (left.length === 0) {
      sessionEnding = true;
      const saved = await getPinnedUrls();
      log("last normal window closed; preserving storage:", saved);
    }
  } catch (err) {
    // If getAll fails during shutdown, err on the side of preserving pins.
    sessionEnding = true;
    warn("windows.onRemoved during shutdown; preserving pins", err);
  }
});

chrome.runtime.onStartup.addListener(() => {
  log("runtime.onStartup");
  scheduleRestoreRetries("onStartup");
});

chrome.runtime.onInstalled.addListener((details) => {
  log("runtime.onInstalled", details.reason);
  scheduleRestoreRetries("onInstalled");
});

// Seed cache and restore whenever the service worker starts.
(async () => {
  try {
    const saved = await getPinnedUrls();
    log("service worker start; stored pins:", saved);

    const tabs = await chrome.tabs.query({ pinned: true });
    for (const tab of tabs) {
      const url = pickUsableUrl(tab);
      if (tab.id != null && url) {
        pinnedTabCache.set(tab.id, { url });
        // Backfill storage if pins exist in the UI but storage was empty/missed.
        await addPinnedUrl(url);
      }
    }
    log("seeded pin cache from", tabs.length, "pinned tabs");
  } catch (err) {
    warn("seed failed", err);
  }

  scheduleRestoreRetries("service-worker-start");
})();
