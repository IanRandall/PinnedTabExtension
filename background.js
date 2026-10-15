/**
 * Proper Pinned Tabs — Safari-style global pinned tabs for Chromium/Brave.
 * Keeps an ordered URL set in chrome.storage.local and restores pins into
 * every normal window until the user unpins or closes a pinned tab while
 * the browser is still open. Closing the last window does not clear the set.
 *
 * Storage grows only on an explicit user pin (changeInfo.pinned === true),
 * never from restore or from navigating inside an already-pinned tab.
 *
 * A pin is a tab identity: navigating inside it must not reload it back to
 * the stored URL, and restore must not close it or create a duplicate for
 * the same storage entry.
 */

const STORAGE_KEY = "pinnedUrls";
/** tabId(string) → storage URL key; survives SW restarts within the browser session. */
const BINDINGS_KEY = "pinTabBindings";
const LOG_PREFIX = "[Proper Pinned Tabs]";

/** Settle time so late create/navigation events stay under the restore guard. */
const RESTORE_SETTLE_MS = 2000;

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

/**
 * tabId → { url, key }
 * `key` is the storage key captured at pin time and must NOT change when the
 * pinned tab navigates (so unpin/close still removes the original entry).
 */
const pinnedTabCache = new Map();

/**
 * Tabs the user just pinned whose URL was not ready yet. Only these may
 * write storage on a later URL commit — not every navigation of a pin.
 */
const awaitingPinUrl = new Set();

/** windowId → in-flight restore Promise (retries coalesce). */
const restoreInFlight = new Map();

/** windowId → last successful restore timestamp (ms). */
const restoreSatisfiedAt = new Map();

/** windowId → settle timeout id (keeps restoringDepth elevated briefly). */
const restoreSettleTimers = new Map();

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

/** tabId → storage key bindings for this browser session. */
async function getBindings() {
  try {
    const result = await chrome.storage.session.get(BINDINGS_KEY);
    const map = result[BINDINGS_KEY];
    return map && typeof map === "object" ? { ...map } : {};
  } catch (err) {
    warn("session bindings read failed", err);
    return {};
  }
}

async function setBindings(map) {
  try {
    await chrome.storage.session.set({ [BINDINGS_KEY]: map });
  } catch (err) {
    warn("session bindings write failed", err);
  }
}

async function bindTabToKey(tabId, key, currentUrl) {
  if (tabId == null || !key) return;
  pinnedTabCache.set(tabId, { url: currentUrl || null, key });
  awaitingPinUrl.delete(tabId);
  const map = await getBindings();
  map[String(tabId)] = key;
  await setBindings(map);
}

async function unbindTab(tabId) {
  if (tabId == null) return;
  pinnedTabCache.delete(tabId);
  awaitingPinUrl.delete(tabId);
  const map = await getBindings();
  if (map[String(tabId)]) {
    delete map[String(tabId)];
    await setBindings(map);
  }
}

/** Add URL to the ordered list if not already present (dedupe by normalized key). */
async function addPinnedUrl(url, reason) {
  if (isRestoring()) {
    log("save skipped (restoring):", url, reason || "");
    return null;
  }
  if (!url || isRestrictedUrl(url)) {
    warn("skip save: restricted or empty URL", url);
    return null;
  }
  const key = normalizeUrlKey(url);
  if (!key) return null;

  const urls = await getPinnedUrls();
  if (urls.some((u) => normalizeUrlKey(u) === key)) {
    log("save skipped (already stored):", url, "key=", key);
    return key;
  }
  urls.push(canonicalStoredUrl(url));
  await setPinnedUrls(urls);
  log("saved pin:", url, "key=", key, reason || "");
  return key;
}

async function removePinnedUrl(urlOrKey, reason) {
  if (!urlOrKey) return;
  const key = normalizeUrlKey(urlOrKey) || urlOrKey;
  const urls = await getPinnedUrls();
  const next = urls.filter((u) => normalizeUrlKey(u) !== key);
  if (next.length === urls.length) {
    log("remove skipped (not in storage):", urlOrKey, reason || "");
    return;
  }
  await setPinnedUrls(next);
  log("removed pin:", urlOrKey, reason || "");
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

function beginRestoreGuard(windowId) {
  restoringDepth += 1;
  const prev = restoreSettleTimers.get(windowId);
  if (prev) clearTimeout(prev);
}

function endRestoreGuard(windowId) {
  const prev = restoreSettleTimers.get(windowId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    restoreSettleTimers.delete(windowId);
    restoringDepth = Math.max(0, restoringDepth - 1);
    log("restore guard cleared for window", windowId, "depth=", restoringDepth);
  }, RESTORE_SETTLE_MS);
  restoreSettleTimers.set(windowId, timer);
}

/**
 * Ensure each saved pin entry is represented by some pinned tab in the window.
 * Never navigates/reloads existing pins. Never closes a pin just because its
 * current URL differs from the stored URL (user may be working in it).
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

    const savedKeys = saved
      .map((u) => normalizeUrlKey(u))
      .filter(Boolean);
    const savedKeySet = new Set(savedKeys);

    // Skip if this window was already fully restored recently and still covered.
    const lastDone = restoreSatisfiedAt.get(windowId);
    if (lastDone && Date.now() - lastDone < 10000) {
      const tabsQuick = await chrome.tabs.query({ windowId, pinned: true });
      const bindingsQuick = await getBindings();
      const coveredQuick = new Set();
      for (const tab of tabsQuick) {
        const bound = bindingsQuick[String(tab.id)];
        if (bound && savedKeySet.has(bound)) coveredQuick.add(bound);
        else {
          const k = tabMatchKey(tab);
          if (k && savedKeySet.has(k)) coveredQuick.add(k);
        }
      }
      if (
        coveredQuick.size >= savedKeys.length ||
        tabsQuick.length >= savedKeys.length
      ) {
        log(
          "restore skip: window already satisfied",
          windowId,
          "pins=",
          tabsQuick.length,
          "covered=",
          coveredQuick.size
        );
        return;
      }
    }

    beginRestoreGuard(windowId);
    try {
      let tabs = await chrome.tabs.query({ windowId });
      let bindings = await getBindings();

      // Drop stale bindings for tabs that no longer exist in this window.
      const liveIds = new Set(tabs.map((t) => String(t.id)));
      let bindingsDirty = false;
      for (const id of Object.keys(bindings)) {
        if (!liveIds.has(id)) {
          delete bindings[id];
          bindingsDirty = true;
        }
      }
      if (bindingsDirty) await setBindings(bindings);

      /** storageKey → pinned tab already bound or URL-matched */
      const pinnedByStorageKey = new Map();
      const unboundPinned = [];

      for (const tab of tabs) {
        if (!tab.pinned || tab.id == null) continue;
        const bound = bindings[String(tab.id)];
        if (bound && savedKeySet.has(bound)) {
          if (!pinnedByStorageKey.has(bound)) {
            pinnedByStorageKey.set(bound, tab);
          }
          pinnedTabCache.set(tab.id, {
            url: pickUsableUrl(tab),
            key: bound,
          });
          continue;
        }
        const urlKey = tabMatchKey(tab);
        if (urlKey && savedKeySet.has(urlKey) && !pinnedByStorageKey.has(urlKey)) {
          pinnedByStorageKey.set(urlKey, tab);
          await bindTabToKey(tab.id, urlKey, pickUsableUrl(tab));
          bindings[String(tab.id)] = urlKey;
          continue;
        }
        unboundPinned.push(tab);
      }

      // If we already have enough pinned tabs for the saved set, bind leftover
      // saved keys to unbound navigated pins — do NOT create or navigate.
      if (
        pinnedByStorageKey.size + unboundPinned.length >= savedKeys.length &&
        pinnedByStorageKey.size < savedKeys.length
      ) {
        for (const key of savedKeys) {
          if (pinnedByStorageKey.has(key)) continue;
          const tab = unboundPinned.shift();
          if (!tab) break;
          await bindTabToKey(tab.id, key, pickUsableUrl(tab));
          bindings[String(tab.id)] = key;
          pinnedByStorageKey.set(key, tab);
          log("restore: bound navigated pin to storage key", key, tab.id);
        }
      }

      if (pinnedByStorageKey.size >= savedKeys.length) {
        restoreSatisfiedAt.set(windowId, Date.now());
        log(
          "restore done (already covered) window",
          windowId,
          "covered=",
          pinnedByStorageKey.size,
          "/",
          savedKeys.length
        );
        return;
      }

      // Refresh tabs/bindings after possible binds.
      tabs = await chrome.tabs.query({ windowId });
      bindings = await getBindings();

      let insertIndex = 0;
      for (const url of saved) {
        const key = normalizeUrlKey(url);
        if (!key) continue;

        const already = pinnedByStorageKey.get(key);
        if (already) {
          // Do not navigate/reload. Optional reorder only.
          if (already.index !== insertIndex) {
            try {
              await chrome.tabs.move(already.id, { index: insertIndex });
            } catch (err) {
              warn("Failed to reorder pin:", key, err);
            }
          }
          insertIndex += 1;
          continue;
        }

        // Prefer pinning an existing unpinned tab with this URL (e.g. history)
        // instead of creating a duplicate tab — only when this slot is missing.
        const unpinnedMatch = tabs.find(
          (t) =>
            !t.pinned &&
            t.id != null &&
            tabMatchKey(t) === key &&
            !bindings[String(t.id)]
        );
        if (unpinnedMatch) {
          try {
            await chrome.tabs.update(unpinnedMatch.id, { pinned: true });
            await chrome.tabs.move(unpinnedMatch.id, { index: insertIndex });
            await bindTabToKey(unpinnedMatch.id, key, pickUsableUrl(unpinnedMatch));
            pinnedByStorageKey.set(key, unpinnedMatch);
            log("restore: pinned existing unpinned tab", url, "key=", key);
          } catch (err) {
            warn("Failed to pin existing tab:", url, err);
          }
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
            await bindTabToKey(created.id, key, url);
            pinnedByStorageKey.set(key, created);
          }
          log("restore: created pinned tab", url, "key=", key);
          insertIndex += 1;
        } catch (err) {
          warn("Failed to create pinned tab:", url, err);
        }
      }

      // Dedupe only: multiple tabs bound to the same storage key (keep first).
      // Never close a pin merely because its current URL ≠ stored URL.
      tabs = await chrome.tabs.query({ windowId, pinned: true });
      bindings = await getBindings();
      /** @type {Map<string, number[]>} */
      const idsByKey = new Map();
      for (const tab of tabs) {
        if (tab.id == null) continue;
        const key = bindings[String(tab.id)];
        if (!key || !savedKeySet.has(key)) continue;
        if (!idsByKey.has(key)) idsByKey.set(key, []);
        idsByKey.get(key).push(tab.id);
      }
      for (const [key, ids] of idsByKey) {
        if (ids.length <= 1) continue;
        const [, ...extras] = ids;
        for (const id of extras) {
          try {
            await unbindTab(id);
            await chrome.tabs.remove(id);
            log("restore: removed duplicate pin for key", key, id);
          } catch (err) {
            warn("Failed to remove duplicate pin", key, id, err);
          }
        }
      }

      restoreSatisfiedAt.set(windowId, Date.now());
      log(
        "restore done window",
        windowId,
        "covered=",
        pinnedByStorageKey.size,
        "/",
        savedKeys.length
      );
    } finally {
      endRestoreGuard(windowId);
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
 * onStartup fires. Retries are idempotent and skip when already satisfied.
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
      const run =
        windowId != null
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

/**
 * Persist a pin only for an explicit user pin (or the first URL commit of a
 * pin that had no URL yet). Navigating inside an already-pinned tab must NOT
 * grow storage.
 */
async function recordUserPin(tabId, tab) {
  const pinUrl = await resolveTabUrl(tabId, tab);
  if (pinUrl) {
    const key = await addPinnedUrl(pinUrl, "user pin");
    if (key) await bindTabToKey(tabId, key, pinUrl);
    else {
      const fallbackKey = normalizeUrlKey(pinUrl);
      if (fallbackKey) await bindTabToKey(tabId, fallbackKey, pinUrl);
    }
    return;
  }
  warn(
    "pin event but URL not ready yet; will save once on first usable URL",
    tabId,
    tab?.url,
    tab?.pendingUrl
  );
  pinnedTabCache.set(tabId, { url: null, key: null });
  awaitingPinUrl.add(tabId);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // First usable URL after a user pin with no URL yet → save once.
  if (
    awaitingPinUrl.has(tabId) &&
    !isRestoring() &&
    !sessionEnding &&
    (changeInfo.url || changeInfo.status === "complete" || tab.url)
  ) {
    const url = await resolveTabUrl(tabId, tab);
    if (url) {
      const key = await addPinnedUrl(url, "deferred user pin URL");
      const bindKey = key || normalizeUrlKey(url);
      if (bindKey) await bindTabToKey(tabId, bindKey, url);
      awaitingPinUrl.delete(tabId);
    }
  } else if (tab.pinned && (changeInfo.url || tab.url)) {
    // Navigated inside a pin: keep storage key; do not addPinnedUrl / reload.
    const cached = pinnedTabCache.get(tabId);
    const bindings = await getBindings();
    const key = cached?.key || bindings[String(tabId)] || null;
    const url = changeInfo.url || tab.url;
    if (key) {
      pinnedTabCache.set(tabId, {
        url: url && !isRestrictedUrl(url) ? url : cached?.url || null,
        key,
      });
    } else if (url && !isRestrictedUrl(url)) {
      pinnedTabCache.set(tabId, { url, key: cached?.key || null });
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
    await recordUserPin(tabId, tab);
  } else if (changeInfo.pinned === false) {
    awaitingPinUrl.delete(tabId);
    if (!(await browserStillOpen())) {
      log("ignore unpin: browser not open / session ending", tabId);
      await unbindTab(tabId);
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
      await unbindTab(tabId);
      return;
    }

    const cached = pinnedTabCache.get(tabId);
    const bindings = await getBindings();
    const unpinKey =
      cached?.key ||
      bindings[String(tabId)] ||
      (await resolveTabUrl(tabId, tab));
    await unbindTab(tabId);
    if (unpinKey) {
      await removePinnedUrl(unpinKey, "user unpin");
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  awaitingPinUrl.delete(tabId);
  const cached = pinnedTabCache.get(tabId);
  const bindings = await getBindings();
  const key = cached?.key || bindings[String(tabId)] || cached?.url;
  await unbindTab(tabId);

  if (!key) {
    return;
  }
  if (isRestoring()) {
    log("ignore remove while restoring", key);
    return;
  }

  if (removeInfo.isWindowClosing || sessionEnding) {
    log(
      "preserve pin on window/session close:",
      key,
      "isWindowClosing=",
      removeInfo.isWindowClosing
    );
    return;
  }

  if (!(await browserStillOpen())) {
    log("preserve pin: no windows left:", key);
    return;
  }

  await removePinnedUrl(key, "pinned tab closed");
});

chrome.windows.onCreated.addListener((win) => {
  sessionEnding = false;
  if (win.type !== "normal") {
    log("window created (non-normal), skip", win.type);
    return;
  }
  log("window created, restoring", win.id);
  scheduleRestoreRetries(`windows.onCreated:${win.id}`, win.id);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  restoreInFlight.delete(windowId);
  restoreSatisfiedAt.delete(windowId);
  const settle = restoreSettleTimers.get(windowId);
  if (settle) {
    clearTimeout(settle);
    restoreSettleTimers.delete(windowId);
    restoringDepth = Math.max(0, restoringDepth - 1);
  }
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

// Seed cache/bindings and restore whenever the service worker starts.
(async () => {
  try {
    const saved = await compactPinnedUrls();
    log("service worker start; stored pins:", saved);

    const savedKeys = new Set(
      saved.map((u) => normalizeUrlKey(u)).filter(Boolean)
    );
    const tabs = await chrome.tabs.query({ pinned: true });
    const bindings = await getBindings();

    for (const tab of tabs) {
      if (tab.id == null) continue;
      const url = pickUsableUrl(tab);
      const urlKey = url ? normalizeUrlKey(url) : null;
      const existing = bindings[String(tab.id)];
      if (existing && savedKeys.has(existing)) {
        pinnedTabCache.set(tab.id, { url, key: existing });
      } else if (urlKey && savedKeys.has(urlKey)) {
        await bindTabToKey(tab.id, urlKey, url);
      } else if (url) {
        pinnedTabCache.set(tab.id, { url, key: existing || null });
      }
    }

    // Backfill only when storage is empty (first install / wiped).
    if (saved.length === 0 && tabs.length > 0) {
      for (const tab of tabs) {
        const url = pickUsableUrl(tab);
        if (url) {
          const key = await addPinnedUrl(url, "empty-storage backfill");
          if (key && tab.id != null) await bindTabToKey(tab.id, key, url);
        }
      }
      log("backfilled empty storage from", tabs.length, "pinned tabs");
    }
    log("seeded pin cache from", tabs.length, "pinned tabs");
  } catch (err) {
    warn("seed failed", err);
  }

  scheduleRestoreRetries("service-worker-start");
})();
