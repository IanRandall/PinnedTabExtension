# Pin Tab Extension

Safari-style global pinned tabs for Brave and Chrome (Manifest V3).

Pinned tab URLs are saved in `chrome.storage.local` and restored as pinned tabs in every normal browser window. Unpinning or closing a pinned tab while the browser is still open removes it from the saved set. Closing the last window does **not** clear the set.

## Load unpacked in Brave

1. Open `brave://extensions` (or **Menu → Extensions → Manage extensions**).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this repository folder (the one that contains `manifest.json`).

The same steps work in Chrome via `chrome://extensions`.

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
