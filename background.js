/**
 * Pin Tab Extension — Safari-style global pinned tabs for Chromium/Brave.
 * Keeps an ordered URL set in chrome.storage.local and restores pins into
 * every normal window until the user unpins or closes a pinned tab while
 * the browser is still open. Closing the last window does not clear the set.
 */

const STORAGE_KEY = "pinnedUrls";

/** In-memory guard: ignore pin/unpin noise while we restore programmatically. */
let restoring = false;

/** tabId → url for pinned tabs (needed because onRemoved has no tab payload). */
const pinnedTabCache = new Map();

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

async function getPinnedUrls() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const list = result[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

async function setPinnedUrls(urls) {
  await chrome.storage.local.set({ [STORAGE_KEY]: urls });
}

/** Add URL to the ordered list if not already present (dedupe by URL). */
async function addPinnedUrl(url) {
  if (!url || isRestrictedUrl(url)) return;
  const urls = await getPinnedUrls();
  if (urls.includes(url)) return;
  urls.push(url);
  await setPinnedUrls(urls);
}

async function removePinnedUrl(url) {
  if (!url) return;
  const urls = await getPinnedUrls();
  const next = urls.filter((u) => u !== url);
  if (next.length === urls.length) return;
  await setPinnedUrls(next);
}

async function resolveTabUrl(tabId, tab) {
  if (tab?.url && !isRestrictedUrl(tab.url)) return tab.url;
  try {
    const full = await chrome.tabs.get(tabId);
    return full.url || null;
  } catch {
    return null;
  }
}

/**
 * Ensure each saved URL is present as a pinned tab in the given window,
 * in stored order. Dedupe by URL within the window; skip restricted URLs.
 */
async function restorePinsInWindow(windowId) {
  if (windowId == null) return;

  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || win.type !== "normal") return;

  const saved = await getPinnedUrls();
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
        console.warn("[Pin Tab Extension] Skipping restricted URL on restore:", url);
        continue;
      }

      const existing = pinnedByUrl.get(url);
      if (existing) {
        if (existing.index !== insertIndex) {
          try {
            await chrome.tabs.move(existing.id, { index: insertIndex });
          } catch (err) {
            console.warn("[Pin Tab Extension] Failed to reorder pin:", url, err);
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
        } catch (err) {
          console.warn("[Pin Tab Extension] Failed to pin existing tab:", url, err);
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
        insertIndex += 1;
      } catch (err) {
        console.warn("[Pin Tab Extension] Failed to create pinned tab:", url, err);
      }
    }
  } finally {
    // Let create/update events settle before we listen for user pin changes again.
    setTimeout(() => {
      restoring = false;
    }, 500);
  }
}

async function restorePinsInAllNormalWindows() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    await restorePinsInWindow(win.id);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Keep cache in sync for URL changes on already-pinned tabs.
  if (tab.pinned && (changeInfo.url || tab.url)) {
    const url = changeInfo.url || tab.url;
    if (url && !isRestrictedUrl(url)) {
      pinnedTabCache.set(tabId, { url });
    }
  }

  if (changeInfo.pinned === undefined) return;
  if (restoring) return;

  if (changeInfo.pinned === true) {
    const pinUrl = await resolveTabUrl(tabId, tab);
    if (pinUrl && !isRestrictedUrl(pinUrl)) {
      pinnedTabCache.set(tabId, { url: pinUrl });
      await addPinnedUrl(pinUrl);
    }
  } else if (changeInfo.pinned === false) {
    const cached = pinnedTabCache.get(tabId);
    pinnedTabCache.delete(tabId);
    const unpinUrl = cached?.url || (await resolveTabUrl(tabId, tab));
    if (unpinUrl) {
      await removePinnedUrl(unpinUrl);
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const cached = pinnedTabCache.get(tabId);
  pinnedTabCache.delete(tabId);
  if (!cached || restoring) return;

  // Closing a whole window (including session end) must not clear the set.
  // Only a direct close of a pinned tab while the browser stays open removes it.
  if (removeInfo.isWindowClosing) return;

  const windows = await chrome.windows.getAll().catch(() => []);
  if (windows.length === 0) return;

  await removePinnedUrl(cached.url);
});

chrome.windows.onCreated.addListener(async (win) => {
  if (win.type !== "normal") return;
  await restorePinsInWindow(win.id);
});

chrome.runtime.onStartup.addListener(() => {
  restorePinsInAllNormalWindows();
});

chrome.runtime.onInstalled.addListener(() => {
  restorePinsInAllNormalWindows();
});

// Seed cache for already-open pinned tabs when the service worker starts.
(async () => {
  try {
    const tabs = await chrome.tabs.query({ pinned: true });
    for (const tab of tabs) {
      if (tab.id != null && tab.url && !isRestrictedUrl(tab.url)) {
        pinnedTabCache.set(tab.id, { url: tab.url });
      }
    }
  } catch {
    // Ignore — may run before APIs are ready.
  }
})();
