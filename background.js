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

import {
  addPinToList,
  dedupeUrlList,
  isRestrictedUrl,
  isWindowAlreadySatisfied,
  normalizeUrlKey,
  pickUsableUrl,
  planRestore,
  removePinFromList,
  shouldPersistNavigatedUrl,
  shouldRemoveOnTabClosed,
} from "./lib/pin-logic.js";

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

/**
 * Keys the user closed/unpinned this session. Restore must not recreate them
 * (even if a concurrent restore already read stale storage, or SW retries fire).
 */
const recentlyClosedKeys = new Map(); // key → timestamp
const CLOSED_SUPPRESS_MS = 120000;

/** Bumped on user close/unpin so in-flight restores abort creating tabs. */
let restoreGeneration = 0;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function isRestoring() {
  return restoringDepth > 0;
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
  const urls = await getPinnedUrls();
  const { list, key, added } = addPinToList(urls, url);
  if (!key) {
    warn("skip save: restricted or empty URL", url);
    return null;
  }
  if (!added) {
    log("save skipped (already stored):", url, "key=", key);
    return key;
  }
  await setPinnedUrls(list);
  log("saved pin:", url, "key=", key, reason || "");
  return key;
}

function noteClosedKey(key) {
  if (!key) return;
  const norm = normalizeUrlKey(key) || key;
  recentlyClosedKeys.set(norm, Date.now());
  restoreGeneration += 1;
  // Force future restores to re-evaluate (do not treat window as satisfied).
  restoreSatisfiedAt.clear();
  log("suppress recreate for closed key", norm, "gen=", restoreGeneration);
}

function clearClosedKey(key) {
  if (!key) return;
  const norm = normalizeUrlKey(key) || key;
  recentlyClosedKeys.delete(norm);
}

function suppressedKeyList() {
  const now = Date.now();
  const out = [];
  for (const [key, ts] of recentlyClosedKeys) {
    if (now - ts > CLOSED_SUPPRESS_MS) {
      recentlyClosedKeys.delete(key);
    } else {
      out.push(key);
    }
  }
  return out;
}

function isSuppressedKey(key) {
  if (!key) return false;
  const norm = normalizeUrlKey(key) || key;
  const ts = recentlyClosedKeys.get(norm);
  if (!ts) return false;
  if (Date.now() - ts > CLOSED_SUPPRESS_MS) {
    recentlyClosedKeys.delete(norm);
    return false;
  }
  return true;
}

async function removePinnedUrl(urlOrKey, reason) {
  if (!urlOrKey) return;
  const key = normalizeUrlKey(urlOrKey) || urlOrKey;
  noteClosedKey(key);
  const urls = await getPinnedUrls();
  const { list, removed } = removePinFromList(urls, urlOrKey);
  if (!removed) {
    log("remove skipped (not in storage):", urlOrKey, reason || "");
    return;
  }
  await setPinnedUrls(list);
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
    const genAtStart = restoreGeneration;
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win || win.type !== "normal") {
      log("restore skip: window missing or not normal", windowId, win?.type);
      return;
    }

    const suppressed = suppressedKeyList();
    const savedRaw = dedupeUrlList(await getPinnedUrls());
    const saved = savedRaw.filter((u) => {
      const key = normalizeUrlKey(u);
      return key && !isSuppressedKey(key);
    });
    log("restore window", windowId, "saved=", saved, "suppressed=", suppressed);
    if (saved.length === 0) {
      restoreSatisfiedAt.set(windowId, Date.now());
      return;
    }

    const bindings = await getBindings();
    const pinnedTabs = await chrome.tabs.query({ windowId, pinned: true });
    if (
      isWindowAlreadySatisfied({
        savedUrls: saved,
        pinnedTabs,
        bindings,
        lastSatisfiedAt: restoreSatisfiedAt.get(windowId) || 0,
      })
    ) {
      log(
        "restore skip: window already satisfied",
        windowId,
        "pins=",
        pinnedTabs.length
      );
      return;
    }

    beginRestoreGuard(windowId);
    try {
      const tabs = await chrome.tabs.query({ windowId });
      const plan = planRestore({
        savedUrls: saved,
        tabs,
        bindings,
        suppressedKeys: suppressed,
      });
      log(
        "restore plan",
        windowId,
        "actions=",
        plan.actions.map((a) => a.type),
        "reason=",
        plan.skipReason
      );

      for (const action of plan.actions) {
        if (restoreGeneration !== genAtStart) {
          log("restore aborted: generation changed (user closed a pin)");
          break;
        }
        try {
          if (action.type === "bind") {
            if (isSuppressedKey(action.key)) continue;
            const tab = tabs.find((t) => t.id === action.tabId);
            await bindTabToKey(
              action.tabId,
              action.key,
              pickUsableUrl(tab) || null
            );
          } else if (action.type === "pin") {
            if (isSuppressedKey(action.key)) continue;
            // Re-check storage — user may have closed this pin mid-restore.
            const stillSaved = (await getPinnedUrls()).some(
              (u) => normalizeUrlKey(u) === action.key
            );
            if (!stillSaved) {
              log("restore skip pin: no longer in storage", action.key);
              continue;
            }
            await chrome.tabs.update(action.tabId, { pinned: true });
            if (action.index != null) {
              await chrome.tabs.move(action.tabId, { index: action.index });
            }
            const tab = tabs.find((t) => t.id === action.tabId);
            await bindTabToKey(
              action.tabId,
              action.key,
              pickUsableUrl(tab) || null
            );
            log("restore: pinned existing unpinned tab", action.key);
          } else if (action.type === "create") {
            if (isSuppressedKey(action.key)) {
              log("restore skip create: suppressed", action.key);
              continue;
            }
            const stillSaved = (await getPinnedUrls()).some(
              (u) => normalizeUrlKey(u) === action.key
            );
            if (!stillSaved) {
              log("restore skip create: no longer in storage", action.key);
              continue;
            }
            if (restoreGeneration !== genAtStart) {
              log("restore skip create: generation changed", action.key);
              break;
            }
            const created = await chrome.tabs.create({
              windowId,
              url: action.url,
              pinned: true,
              active: false,
              index: action.index,
            });
            if (created.id != null) {
              await bindTabToKey(created.id, action.key, action.url);
            }
            log("restore: created pinned tab", action.url, "key=", action.key);
          } else if (action.type === "move") {
            await chrome.tabs.move(action.tabId, { index: action.index });
          } else if (action.type === "removeDuplicate") {
            await unbindTab(action.tabId);
            await chrome.tabs.remove(action.tabId);
            log(
              "restore: removed duplicate pin for key",
              action.key,
              action.tabId
            );
          }
        } catch (err) {
          warn("restore action failed", action, err);
        }
      }

      if (restoreGeneration === genAtStart) {
        restoreSatisfiedAt.set(windowId, Date.now());
      }
      log(
        "restore done window",
        windowId,
        "covered=",
        plan.coveredKeys.length,
        "/",
        saved.length
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
 * Schedule restore sparingly. Aggressive multi-timer retries fought user closes
 * and were implicated in a Brave main-thread crash (CFRunLoop timer / tab thrash).
 *
 * - onStartup: one deferred pass + one late pass for session restore
 * - windows.onCreated: single short defer (tab strip ready)
 * - onInstalled: single pass
 * - service-worker-start: NO restore — mid-session SW wakes must not thrash
 */
function scheduleRestoreRetries(reason, windowId = null) {
  if (reason === "service-worker-start") {
    log("skip restore on SW start (avoid timer thrash / close races)");
    return;
  }
  if (scheduledReasons.has(reason)) {
    log("restore already scheduled for", reason);
    return;
  }
  scheduledReasons.add(reason);

  let delays;
  if (reason === "onStartup") {
    delays = [600, 2500];
  } else if (String(reason).startsWith("windows.onCreated")) {
    delays = [400];
  } else {
    delays = [0];
  }

  log("schedule restore:", reason, "delays=", delays, "windowId=", windowId);
  let remaining = delays.length;
  for (const ms of delays) {
    setTimeout(() => {
      const run =
        windowId != null
          ? restorePinsInWindow(windowId)
          : restorePinsInAllNormalWindows();
      Promise.resolve(run)
        .catch((err) => warn("restore failed:", err))
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
    const maybeKey = normalizeUrlKey(pinUrl);
    if (maybeKey) clearClosedKey(maybeKey);
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
  const awaiting = awaitingPinUrl.has(tabId);
  const mayPersist = shouldPersistNavigatedUrl({
    isRestoring: isRestoring(),
    sessionEnding,
    awaitingFirstPinUrl: awaiting,
    changePinned: changeInfo.pinned,
  });

  // First usable URL after a user pin with no URL yet → save once.
  if (
    awaiting &&
    mayPersist &&
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
      // Keep bindings so a late onRemoved can still decide; session end preserves.
      return;
    }
    let stillExists = true;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      stillExists = false;
    }
    if (!stillExists) {
      // Closing a pinned tab often fires pinned→false after the tab is gone.
      // Do NOT unbind or remove here — that raced onRemoved and left stale
      // pinnedUrls (pins reappeared in a new window). Let onRemoved handle it.
      log("ignore unpin: tab closing; defer remove to onRemoved", tabId);
      return;
    }

    // Explicit user unpin (tab still open).
    const cached = pinnedTabCache.get(tabId);
    const bindings = await getBindings();
    const unpinKey =
      cached?.key ||
      bindings[String(tabId)] ||
      (await resolveTabUrl(tabId, tab));
    await unbindTab(tabId);
    if (unpinKey) {
      clearClosedKey(unpinKey); // will re-note inside removePinnedUrl
      await removePinnedUrl(unpinKey, "user unpin");
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  awaitingPinUrl.delete(tabId);
  // Read key BEFORE unbind — unpin-on-close used to clear bindings first and
  // then onRemoved had nothing to remove from storage.
  const cached = pinnedTabCache.get(tabId);
  const bindings = await getBindings();
  const key = cached?.key || bindings[String(tabId)] || cached?.url || null;

  if (!key) {
    await unbindTab(tabId);
    log("onRemoved: no pin key for tab", tabId, "— storage unchanged");
    return;
  }

  const stillOpen = await browserStillOpen();
  const shouldRemove = shouldRemoveOnTabClosed({
    sessionEnding,
    isWindowClosing: !!removeInfo.isWindowClosing,
    browserStillOpen: stillOpen,
  });

  await unbindTab(tabId);

  if (!shouldRemove) {
    log(
      "preserve pin on close:",
      key,
      "isWindowClosing=",
      removeInfo.isWindowClosing,
      "sessionEnding=",
      sessionEnding
    );
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
