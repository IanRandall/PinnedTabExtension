/**
 * Pure pin storage / restore rules for Proper Pinned Tabs.
 * Used by the service worker and by Node unit tests (no chrome.* here).
 */

/** Restricted schemes that extensions cannot open. */
export function isRestrictedUrl(url) {
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
export function normalizeUrlKey(url) {
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
export function canonicalStoredUrl(url) {
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

export function pickUsableUrl(tab) {
  if (!tab) return null;
  for (const candidate of [tab.url, tab.pendingUrl]) {
    if (candidate && !isRestrictedUrl(candidate)) return candidate;
  }
  return null;
}

export function tabMatchKey(tab) {
  const url = pickUsableUrl(tab);
  return url ? normalizeUrlKey(url) : null;
}

/** Dedupe by normalized key; preserve first-seen order; rewrite to canonical. */
export function dedupeUrlList(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    if (!raw || isRestrictedUrl(raw)) continue;
    const key = normalizeUrlKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(canonicalStoredUrl(raw));
  }
  return out;
}

/**
 * Navigating inside an already-pinned tab must never append to storage.
 * Only an explicit user pin (or deferred first URL for awaitingPinUrl) may save.
 */
export function shouldPersistNavigatedUrl({
  isRestoring = false,
  sessionEnding = false,
  awaitingFirstPinUrl = false,
  changePinned,
} = {}) {
  if (isRestoring || sessionEnding) return false;
  if (changePinned === true) return true;
  if (awaitingFirstPinUrl) return true;
  // URL change on an already-pinned tab → do not persist.
  return false;
}

/** Append a pin URL once (deduped). Returns { list, key, added }. */
export function addPinToList(urls, url) {
  const list = dedupeUrlList(urls);
  if (!url || isRestrictedUrl(url)) {
    return { list, key: null, added: false };
  }
  const key = normalizeUrlKey(url);
  if (!key) return { list, key: null, added: false };
  if (list.some((u) => normalizeUrlKey(u) === key)) {
    return { list, key, added: false };
  }
  return {
    list: [...list, canonicalStoredUrl(url)],
    key,
    added: true,
  };
}

/** Remove by URL or normalized key. Returns { list, removed }. */
export function removePinFromList(urls, urlOrKey) {
  const list = dedupeUrlList(urls);
  if (!urlOrKey) return { list, removed: false };
  const key = normalizeUrlKey(urlOrKey) || urlOrKey;
  const next = list.filter((u) => normalizeUrlKey(u) !== key);
  return { list: next, removed: next.length !== list.length };
}

/**
 * Whether closing a pinned tab should remove it from storage.
 * Session end / window closing must preserve storage.
 */
export function shouldRemoveOnTabClosed({
  isRestoring = false,
  sessionEnding = false,
  isWindowClosing = false,
  browserStillOpen = true,
} = {}) {
  if (isRestoring) return false;
  if (sessionEnding || isWindowClosing) return false;
  if (!browserStillOpen) return false;
  return true;
}

/**
 * Plan restore for one window. Pure decision list — no chrome calls.
 *
 * Input tabs: { id, pinned, url?, pendingUrl?, index? }
 * bindings: { [tabId]: storageKey }
 *
 * Actions:
 * - bind { tabId, key }
 * - pin { tabId, key }  (pin existing unpinned)
 * - create { url, key, index }
 * - move { tabId, index }
 * - removeDuplicate { tabId, key }
 *
 * Never emits navigate/reload/close for URL mismatch (navigated pins stay).
 */
export function planRestore({ savedUrls, tabs, bindings = {} } = {}) {
  const saved = dedupeUrlList(savedUrls);
  const savedKeys = saved.map((u) => normalizeUrlKey(u)).filter(Boolean);
  const savedKeySet = new Set(savedKeys);
  const actions = [];
  const nextBindings = { ...bindings };

  if (savedKeys.length === 0) {
    return {
      actions,
      coveredKeys: [],
      complete: true,
      nextBindings,
      skipReason: "empty-saved",
    };
  }

  const liveIds = new Set(
    (tabs || []).filter((t) => t.id != null).map((t) => String(t.id))
  );
  for (const id of Object.keys(nextBindings)) {
    if (!liveIds.has(id)) delete nextBindings[id];
  }

  const pinnedByStorageKey = new Map();
  const unboundPinned = [];

  for (const tab of tabs || []) {
    if (!tab.pinned || tab.id == null) continue;
    const id = String(tab.id);
    const bound = nextBindings[id];
    if (bound && savedKeySet.has(bound)) {
      if (!pinnedByStorageKey.has(bound)) pinnedByStorageKey.set(bound, tab);
      continue;
    }
    const urlKey = tabMatchKey(tab);
    if (urlKey && savedKeySet.has(urlKey) && !pinnedByStorageKey.has(urlKey)) {
      pinnedByStorageKey.set(urlKey, tab);
      nextBindings[id] = urlKey;
      actions.push({ type: "bind", tabId: tab.id, key: urlKey });
      continue;
    }
    unboundPinned.push(tab);
  }

  // Enough pins already (some may have navigated): bind leftover keys — no create.
  if (
    pinnedByStorageKey.size + unboundPinned.length >= savedKeys.length &&
    pinnedByStorageKey.size < savedKeys.length
  ) {
    for (const key of savedKeys) {
      if (pinnedByStorageKey.has(key)) continue;
      const tab = unboundPinned.shift();
      if (!tab) break;
      nextBindings[String(tab.id)] = key;
      pinnedByStorageKey.set(key, tab);
      actions.push({ type: "bind", tabId: tab.id, key });
    }
  }

  if (pinnedByStorageKey.size >= savedKeys.length) {
    // Dedupe only: multiple tabs bound to same key.
    const idsByKey = new Map();
    for (const [id, key] of Object.entries(nextBindings)) {
      if (!savedKeySet.has(key)) continue;
      const tab = (tabs || []).find((t) => String(t.id) === id && t.pinned);
      if (!tab) continue;
      if (!idsByKey.has(key)) idsByKey.set(key, []);
      idsByKey.get(key).push(Number(id));
    }
    for (const [key, ids] of idsByKey) {
      if (ids.length <= 1) continue;
      for (const extraId of ids.slice(1)) {
        actions.push({ type: "removeDuplicate", tabId: extraId, key });
        delete nextBindings[String(extraId)];
      }
    }
    return {
      actions,
      coveredKeys: [...pinnedByStorageKey.keys()],
      complete: true,
      nextBindings,
      skipReason: "already-covered",
    };
  }

  let insertIndex = 0;
  for (const url of saved) {
    const key = normalizeUrlKey(url);
    if (!key) continue;

    const already = pinnedByStorageKey.get(key);
    if (already) {
      if (already.index != null && already.index !== insertIndex) {
        actions.push({
          type: "move",
          tabId: already.id,
          index: insertIndex,
        });
      }
      insertIndex += 1;
      continue;
    }

    const unpinnedMatch = (tabs || []).find(
      (t) =>
        !t.pinned &&
        t.id != null &&
        tabMatchKey(t) === key &&
        !nextBindings[String(t.id)]
    );
    if (unpinnedMatch) {
      actions.push({
        type: "pin",
        tabId: unpinnedMatch.id,
        key,
        index: insertIndex,
      });
      nextBindings[String(unpinnedMatch.id)] = key;
      pinnedByStorageKey.set(key, unpinnedMatch);
      insertIndex += 1;
      continue;
    }

    actions.push({
      type: "create",
      url: canonicalStoredUrl(url),
      key,
      index: insertIndex,
    });
    insertIndex += 1;
  }

  return {
    actions,
    coveredKeys: [...pinnedByStorageKey.keys()],
    complete: true,
    nextBindings,
    skipReason: null,
  };
}

/** True if restore should be skipped because coverage is already sufficient. */
export function isWindowAlreadySatisfied({
  savedUrls,
  pinnedTabs,
  bindings = {},
  lastSatisfiedAt = 0,
  now = Date.now(),
  skipWindowMs = 10000,
} = {}) {
  if (!lastSatisfiedAt || now - lastSatisfiedAt >= skipWindowMs) return false;
  const saved = dedupeUrlList(savedUrls);
  const savedKeys = saved.map((u) => normalizeUrlKey(u)).filter(Boolean);
  if (savedKeys.length === 0) return true;
  const savedKeySet = new Set(savedKeys);
  const covered = new Set();
  for (const tab of pinnedTabs || []) {
    const bound = bindings[String(tab.id)];
    if (bound && savedKeySet.has(bound)) covered.add(bound);
    else {
      const k = tabMatchKey(tab);
      if (k && savedKeySet.has(k)) covered.add(k);
    }
  }
  return (
    covered.size >= savedKeys.length ||
    (pinnedTabs || []).length >= savedKeys.length
  );
}
