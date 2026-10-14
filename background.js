/**
 * Proper Pinned Tabs — Safari-style global pinned tabs for Chromium/Brave.
 * Keeps an ordered URL set in chrome.storage.local and restores pins into
 * every normal window until the user unpins or closes a pinned tab while
 * the browser is still open. Closing the last window does not clear the set.
 */

const STORAGE_KEY = "pinnedUrls";
const LOG_PREFIX = "[Proper Pinned Tabs]";

/**
 * While > 0, ignore pin/unpin/storage writes from programmatic restore.
 * Nested restores (retries) increment/decrement so the guard covers overlaps.
 */
let restoringDepth = 0;

/**
 * Set when the last window is gone / session is ending so late unpin/remove
 * events cannot wipe chrome.storage.local.
 */
let sessionEnding = false;

/** tabId → { url, key } for pinned tabs (onRemoved has no tab payload). */
const pinnedTabCache = new Map();

/** windowId → in-flight restore Promise (retries coalesce). */
const restoreInFlight = new Map();

/** windowId → last successful restore timestamp (ms). */
const restoreSatisfiedAt = new Map();

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function isRestoring() {
  return restoringDepth > 0;
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

/**
 * Canonical key for dedupe/matching across trailing slash, http/https,
 * default ports, and hash differences. Query string is kept (meaningful).
 */
function normalizeUrlKey(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (isRestrictedUrl(url)) return null;
    let path = u.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    const host = u.hostname.toLowerCase();
    // Ignore protocol (http vs https) and hash for matching.
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** Prefer https when rewriting a stored URL for tabs.create. */
function canonicalStoredUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    const protocol =
      u.protocol === "http:" || u.protocol === "https:" ? "https:" : u.protocol;
    const port =
      u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
    return `${protocol}//${u.hostname.toLowerCase()}${port}${path}${u.search}`;
  } catch {
    return url;
  }
}

function pickUsableUrl(tab) {
  if (!tab) return null;
  for (const candidate of [tab.url, tab.pendingUrl]) {
    if (candidate && !isRestrictedUrl(candidate)) return candidate;
  }
  return null;
}

function tabMatchKey(tab) {
  const url = pickUsableUrl(tab);
  return url ? normalizeUrlKey(url) : null;
}

/** Dedupe by normalized key; preserve first-seen order; rewrite to canonical. */
function dedupeUrlList(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    if (!raw || isRestrictedUrl(raw)) continue;
    const key = normalizeUrlKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalStoredUrl(raw));
  }
  return out;
}

async function getPinnedUrls() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const list = result[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function setPinnedUrls(urls) {
  const deduped = dedupeUrlList(urls);
  await chrome.storage.local.set({ [STORAGE_KEY]: deduped });
  log("storage updated:", deduped);
  return deduped;
}

/** Compact storage if duplicates / non-canonical entries accumulated. */
async function compactPinnedUrls() {
  const urls = await getPinnedUrls();
  const deduped = dedupeUrlList(urls);
  if (
    deduped.length !== urls.length ||
    deduped.some((u, i) => u !== urls[i])
  ) {
    await chrome.storage.local.set({ [STORAGE_KEY]: deduped });
    log("storage compacted:", urls, "→", deduped);
  }
  return deduped;
}

/** Add URL to the ordered list if not already present (dedupe by normalized key). */
async function addPinnedUrl(url) {
  if (isRestoring()) {
    log("save skipped (restoring):", url);
    return;
  }
  if (!url || isRestrictedUrl(url)) {
    warn("skip save: restricted or empty URL", url);
    return;
  }
  const key = normalizeUrlKey(url);
  if (!key) return;

  const urls = await getPinnedUrls();
  if (urls.some((u) => normalizeUrlKey(u) === key)) {
    log("save skipped (already stored):", url, "key=", key);
    return;
  }
  urls.push(canonicalStoredUrl(url));
  await setPinnedUrls(urls);
  log("saved pin:", url, "key=", key);
}

async function removePinnedUrl(url, reason) {
  if (!url) return;
  const key = normalizeUrlKey(url);
  const urls = await getPinnedUrls();
  const next = key
    ? urls.filter((u) => normalizeUrlKey(u) !== key)
    : urls.filter((u) => u !== url);
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
 * in stored order. Matching uses normalized URL keys. Idempotent / safe to retry.
 */
async function restorePinsInWindow(windowId) {
  if (windowId == null) return;

  const existingFlight = restoreInFlight.get(windowId);
  if (existingFlight) {
    log("restore coalesce: already in flight for window", windowId);
    return existingFlight;
  }

  const flight = (async () => {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win || win.type !== "normal") {
      log("restore skip: window missing or not normal", windowId, win?.type);
      return;
    }

    const saved = dedupeUrlList(await getPinnedUrls());
    log("restore window", windowId, "saved=", saved);
    if (saved.length === 0) {
      restoreSatisfiedAt.set(windowId, Date.now());
      return;
    }

    restoringDepth += 1;
    try {
      // Re-query tabs each pass so session-restored tabs are visible.
      let tabs = await chrome.tabs.query({ windowId });

      /** @type {Map<string, chrome.tabs.Tab>} */
      const tabsByKey = new Map();
      for (const tab of tabs) {
        const key = tabMatchKey(tab);
        if (!key) continue;
        const prev = tabsByKey.get(key);
        // Prefer an already-pinned tab when several match the same key.
        if (!prev || (tab.pinned && !prev.pinned)) {
          tabsByKey.set(key, tab);
        }
      }

      const satisfied = new Set();
      let insertIndex = 0;

      for (const url of saved) {
        const key = normalizeUrlKey(url);
        if (!key) {
          warn("Skipping restricted/unparseable URL on restore:", url);
          continue;
        }
        if (satisfied.has(key)) continue;

        const existing = tabsByKey.get(key);
        if (existing) {
          try {
            if (!existing.pinned) {
              await chrome.tabs.update(existing.id, { pinned: true });
              log("restore: pinned existing tab", url, "key=", key);
            }
            if (existing.index !== insertIndex) {
              await chrome.tabs.move(existing.id, { index: insertIndex });
            }
            if (existing.id != null) {
              pinnedTabCache.set(existing.id, { url, key });
            }
          } catch (err) {
            warn("Failed to adopt existing tab:", url, err);
          }
          satisfied.add(key);
          insertIndex += 1;
          continue;
        }

        try {
          const created = await chrome.tabs.create({
            windowId,
            url: canonicalStoredUrl(url),
            pinned: true,
            active: false,
            index: insertIndex,
          });
          if (created.id != null) {
            pinnedTabCache.set(created.id, { url, key });
            tabsByKey.set(key, created);
          }
          log("restore: created pinned tab", url, "key=", key);
          satisfied.add(key);
          insertIndex += 1;
        } catch (err) {
          warn("Failed to create pinned tab:", url, err);
        }
      }

      // Refresh and close extra pinned tabs that duplicate a saved key
      // (e.g. leftovers from older buggy restores). Keep the first by index.
      tabs = await chrome.tabs.query({ windowId });
      const savedKeys = new Set(
        saved.map((u) => normalizeUrlKey(u)).filter(Boolean)
      );
      /** @type {Map<string, number[]>} */
      const pinnedIdsByKey = new Map();
      for (const tab of tabs) {
        if (!tab.pinned || tab.id == null) continue;
        const key = tabMatchKey(tab);
        if (!key || !savedKeys.has(key)) continue;
        if (!pinnedIdsByKey.has(key)) pinnedIdsByKey.set(key, []);
        pinnedIdsByKey.get(key).push(tab.id);
      }
      for (const [key, ids] of pinnedIdsByKey) {
        if (ids.length <= 1) continue;
        // Keep the first; remove the rest so pin count matches storage.
        const [, ...extras] = ids;
        for (const id of extras) {
          try {
            pinnedTabCache.delete(id);
            await chrome.tabs.remove(id);
            log("restore: removed duplicate pinned tab", key, id);
          } catch (err) {
            warn("Failed to remove duplicate pin", key, id, err);
          }
        }
      }

      restoreSatisfiedAt.set(windowId, Date.now());
      log(
        "restore done window",
        windowId,
        "satisfied",
        satisfied.size,
        "/",
        saved.length
      );
    } finally {
      restoringDepth -= 1;
    }
  })();

  restoreInFlight.set(windowId, flight);
  try {
    await flight;
  } finally {
    restoreInFlight.delete(windowId);
  }
}

async function restorePinsInAllNormalWindows() {
  sessionEnding = false;
  await compactPinnedUrls();
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

/** Per-reason retry timers so we don't stack endless overlapping schedules. */
const scheduledReasons = new Set();

/**
 * Startup/session restore races: windows or tabs may not exist yet when
 * onStartup fires. Retries are idempotent (normalize match + in-flight lock).
 */
function scheduleRestoreRetries(reason, windowId = null) {
  if (scheduledReasons.has(reason)) {
    log("restore retries already scheduled for", reason);
    return;
  }
  scheduledReasons.add(reason);
  log("schedule restore retries:", reason, "windowId=", windowId);

  const delays = [0, 500, 1500, 3000];
  let remaining = delays.length;
  for (const ms of delays) {
    setTimeout(() => {
      const run = windowId != null
        ? restorePinsInWindow(windowId)
        : restorePinsInAllNormalWindows();
      Promise.resolve(run)
        .catch((err) => warn("restore retry failed:", err))
        .finally(() => {
          remaining -= 1;
          if (remaining <= 0) scheduledReasons.delete(reason);
        });
    }, ms);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Keep cache in sync; never grow storage from restore-driven updates.
  if (tab.pinned && (changeInfo.url || changeInfo.status === "complete")) {
    const url = await resolveTabUrl(tabId, tab);
    if (url) {
      const key = normalizeUrlKey(url);
      pinnedTabCache.set(tabId, { url, key });
      if (changeInfo.url && !isRestoring() && !sessionEnding) {
        await addPinnedUrl(url);
      }
    }
  } else if (tab.pinned && (changeInfo.url || tab.url)) {
    const url = changeInfo.url || tab.url;
    if (url && !isRestrictedUrl(url)) {
      pinnedTabCache.set(tabId, { url, key: normalizeUrlKey(url) });
    }
  }

  if (changeInfo.pinned === undefined) return;
  if (isRestoring()) {
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
      pinnedTabCache.set(tabId, {
        url: pinUrl,
        key: normalizeUrlKey(pinUrl),
      });
      await addPinnedUrl(pinUrl);
    } else {
      warn(
        "pin event but URL not ready yet; will save on next URL update",
        tabId,
        tab?.url,
        tab?.pendingUrl
      );
      pinnedTabCache.set(tabId, { url: null, key: null });
    }
  } else if (changeInfo.pinned === false) {
    if (!(await browserStillOpen())) {
      log("ignore unpin: browser not open / session ending", tabId);
      pinnedTabCache.delete(tabId);
      return;
    }
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
  if (isRestoring()) {
    log("ignore remove while restoring", cached.url);
    return;
  }

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
  // Only restore this window (not every window) to avoid cross-window churn.
  scheduleRestoreRetries(`windows.onCreated:${win.id}`, win.id);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  restoreInFlight.delete(windowId);
  restoreSatisfiedAt.delete(windowId);
  try {
    const left = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (left.length === 0) {
      sessionEnding = true;
      const saved = await getPinnedUrls();
      log("last normal window closed; preserving storage:", saved);
    }
  } catch (err) {
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

// Seed cache, compact storage, restore whenever the service worker starts.
(async () => {
  try {
    const saved = await compactPinnedUrls();
    log("service worker start; stored pins:", saved);

    const tabs = await chrome.tabs.query({ pinned: true });
    for (const tab of tabs) {
      const url = pickUsableUrl(tab);
      if (tab.id != null && url) {
        pinnedTabCache.set(tab.id, { url, key: normalizeUrlKey(url) });
      }
    }
    // Backfill storage only for keys missing from the saved list — never
    // append variants that normalize to an existing entry.
    if (saved.length === 0 && tabs.length > 0) {
      for (const tab of tabs) {
        const url = pickUsableUrl(tab);
        if (url) await addPinnedUrl(url);
      }
      log("backfilled empty storage from", tabs.length, "pinned tabs");
    }
    log("seeded pin cache from", tabs.length, "pinned tabs");
  } catch (err) {
    warn("seed failed", err);
  }

  scheduleRestoreRetries("service-worker-start");
})();
