# Proper Pinned Tabs

Safari-style global pinned tabs for Brave and Chrome (Manifest V3).

Pinned tab URLs are saved in `chrome.storage.local` and restored as pinned tabs in every normal browser window. Unpinning or closing a pinned tab while the browser is still open removes it from the saved set. Closing the last window does **not** clear the set.

Privacy: see [PRIVACY.md](PRIVACY.md).

## Install (recommended)

**Chrome Web Store** — works in Chrome and Brave:

1. Open [Proper Pinned Tabs on the Chrome Web Store](https://chromewebstore.google.com/detail/proper-pinned-tabs/ppoaagcjajlmahlocfkbcgjdoffhmpen).
2. Click **Add to Chrome** (in Brave the button may say **Add to Brave** / **Install**).
3. Confirm when prompted.

## Alternatives (developers / offline)

### GitHub release (load unpacked)

1. Download the latest `.zip` from [Releases](https://github.com/IanRandall/ProperPinnedTabs/releases/latest).
2. Unzip it (you should get a folder containing `manifest.json`).
3. Open `brave://extensions` or `chrome://extensions`.
4. Turn on **Developer mode** → **Load unpacked** → select the unzipped folder.

### From source

1. Clone or download this repository.
2. Open `brave://extensions` or `chrome://extensions` → **Developer mode** → **Load unpacked**.
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
| `background.js` | Pin storage + restore logic (ES module) |
| `lib/pin-logic.js` | Pure pin/storage/restore rules (unit-tested) |
| `icons/` | Extension icons |

No popup, options page, or sync in v1.

## Tests

Requires Node 18+ (uses the built-in test runner; no install step).

```bash
npm test
```

Covers pin/unpin/close storage rules, restore planning (including no resurrection after close, no wipe of navigated pins), restricted URLs, and normalization edge cases. CI runs the same command on pull requests and pushes to `main`.

## Debugging

On `brave://extensions` (or `chrome://extensions`), open **Service worker** for this extension. The console logs save / remove / restore actions prefixed with `[Proper Pinned Tabs]`. After updating a load-unpacked build, click **Reload** on the extension card before retesting.
