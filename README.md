# Proper Pinned Tabs

Safari-style global pinned tabs for Brave and Chrome (Manifest V3).

Pinned tab URLs are saved in `chrome.storage.local` and restored as pinned tabs in every normal browser window. Unpinning or closing a pinned tab while the browser is still open removes it from the saved set. Closing the last window does **not** clear the set.

## Install from release

1. Open the [latest GitHub Release](https://github.com/IanRandall/ProperPinnedTabs/releases/latest) and download the latest `.zip` asset.
2. Unzip the file (you should get a folder containing `manifest.json`).
3. Open `brave://extensions` (or **Menu → Extensions → Manage extensions**).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.

The same steps work in Chrome via `chrome://extensions`.

## Load unpacked from source

1. Clone or download this repository.
2. Open `brave://extensions` → **Developer mode** → **Load unpacked**.
3. Select this repository folder (the one that contains `manifest.json`).

## How it works

- **Pin a tab** → its URL is added to the ordered global list (deduped).
- **Unpin a tab** → that URL is removed from the list.
- **Close a pinned tab** (browser still open) → that URL is removed.
- **New window / browser restart** → saved URLs are re-pinned in order in each normal window.
- Restricted URLs (`chrome://`, `brave://`, etc.) are skipped on restore.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (`tabs`, `storage`, service worker) |
| `background.js` | Pin storage + restore logic |
| `icons/` | Extension icons |

No popup, options page, or sync in v1.

## Debugging

On `brave://extensions`, open **Service worker** for this extension. The console logs save / remove / restore actions prefixed with `[Proper Pinned Tabs]`. After pulling an update, click **Reload** on the extension card before retesting.
