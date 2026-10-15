import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPinToList,
  canonicalStoredUrl,
  dedupeUrlList,
  isWindowAlreadySatisfied,
  normalizeUrlKey,
  planRestore,
  removePinFromList,
  shouldPersistNavigatedUrl,
  shouldRemoveOnTabClosed,
} from "../lib/pin-logic.js";

describe("normalizeUrlKey / dedupe", () => {
  it("treats trailing slash and http/https as the same key", () => {
    assert.equal(
      normalizeUrlKey("https://Example.com/foo/"),
      normalizeUrlKey("http://example.com/foo")
    );
  });

  it("dedupes a polluted list to canonical https URLs", () => {
    const out = dedupeUrlList([
      "http://mlh.com/",
      "https://mlh.com",
      "https://mlh.com/challenges/abc",
    ]);
    assert.deepEqual(out, [
      "https://mlh.com/",
      "https://mlh.com/challenges/abc",
    ]);
  });
});

describe("storage growth (pin-growth regression)", () => {
  it("explicit pin adds once", () => {
    let { list, added, key } = addPinToList([], "https://hacktoberfest.com/");
    assert.equal(added, true);
    assert.ok(key);
    ({ list, added } = addPinToList(list, "https://hacktoberfest.com"));
    assert.equal(added, false);
    assert.equal(list.length, 1);
  });

  it("navigating inside a pinned tab must NOT append URLs to storage", () => {
    const start = addPinToList([], "https://mlh.com/").list;
    // Old bug: every changeInfo.url while pinned called addPinToList.
    // Correct rule: shouldPersistNavigatedUrl is false for plain navigations.
    assert.equal(
      shouldPersistNavigatedUrl({
        awaitingFirstPinUrl: false,
        changePinned: undefined,
      }),
      false
    );
    let list = start;
    for (const url of [
      "https://mlh.com/challenges/1",
      "https://mlh.com/challenges/2",
      "https://hacktoberfest.com/my",
      "https://hacktoberfest.com/schedule",
    ]) {
      if (
        shouldPersistNavigatedUrl({
          awaitingFirstPinUrl: false,
          changePinned: undefined,
        })
      ) {
        list = addPinToList(list, url).list;
      }
    }
    assert.equal(list.length, 1);
    assert.equal(canonicalStoredUrl(list[0]), "https://mlh.com/");
  });

  it("deferred first URL after pin may persist once", () => {
    assert.equal(
      shouldPersistNavigatedUrl({
        awaitingFirstPinUrl: true,
        changePinned: undefined,
      }),
      true
    );
    assert.equal(
      shouldPersistNavigatedUrl({
        changePinned: true,
      }),
      true
    );
  });

  it("unpin/close removes from the list", () => {
    let list = addPinToList([], "https://a.example/").list;
    list = addPinToList(list, "https://b.example/").list;
    assert.equal(list.length, 2);
    const removed = removePinFromList(list, "https://a.example");
    assert.equal(removed.removed, true);
    assert.equal(removed.list.length, 1);
    assert.match(removed.list[0], /b\.example/);
  });
});

describe("session-end must not wipe storage", () => {
  it("window closing does not remove", () => {
    assert.equal(
      shouldRemoveOnTabClosed({
        isWindowClosing: true,
        browserStillOpen: true,
      }),
      false
    );
  });

  it("session ending / no windows does not remove", () => {
    assert.equal(
      shouldRemoveOnTabClosed({
        sessionEnding: true,
        browserStillOpen: false,
      }),
      false
    );
    assert.equal(
      shouldRemoveOnTabClosed({
        isWindowClosing: false,
        browserStillOpen: false,
      }),
      false
    );
  });

  it("manual close while browser open does remove", () => {
    assert.equal(
      shouldRemoveOnTabClosed({
        isWindowClosing: false,
        browserStillOpen: true,
      }),
      true
    );
  });
});

describe("restore must not wipe in-pin work (v1.0.7 regression)", () => {
  const saved = ["https://mlh.com/", "https://hacktoberfest.com/"];

  it("does not close/reload a navigated pinned tab; binds it instead of create", () => {
    const plan = planRestore({
      savedUrls: saved,
      bindings: { "10": "mlh.com/" },
      tabs: [
        {
          id: 10,
          pinned: true,
          // Navigated away from stored URL — old bug closed this as orphan.
          url: "https://mlh.com/challenges/deep",
          index: 0,
        },
        {
          id: 11,
          pinned: true,
          url: "https://hacktoberfest.com/my",
          index: 1,
        },
      ],
    });

    assert.equal(plan.complete, true);
    assert.equal(plan.skipReason, "already-covered");
    assert.equal(
      plan.actions.some((a) => a.type === "create"),
      false
    );
    assert.equal(
      plan.actions.some((a) => a.type === "removeDuplicate"),
      false
    );
    // No action type for navigate/reload/close-for-mismatch exists.
    assert.equal(
      plan.actions.some((a) =>
        ["navigate", "reload", "closeOrphan"].includes(a.type)
      ),
      false
    );
    // Second navigated pin should get bound to remaining saved key.
    assert.equal(plan.nextBindings["11"], "hacktoberfest.com/");
    assert.ok(plan.actions.some((a) => a.type === "bind" && a.tabId === 11));
  });

  it("does not create a duplicate when a bound pin already exists", () => {
    const plan = planRestore({
      savedUrls: saved,
      bindings: {
        "1": "mlh.com/",
        "2": "hacktoberfest.com/",
      },
      tabs: [
        { id: 1, pinned: true, url: "https://mlh.com/elsewhere", index: 0 },
        {
          id: 2,
          pinned: true,
          url: "https://hacktoberfest.com/elsewhere",
          index: 1,
        },
      ],
    });
    assert.equal(plan.actions.filter((a) => a.type === "create").length, 0);
    assert.equal(plan.complete, true);
  });

  it("creates only missing pins in an empty window", () => {
    const plan = planRestore({
      savedUrls: saved,
      bindings: {},
      tabs: [{ id: 99, pinned: false, url: "https://example.com/", index: 0 }],
    });
    const creates = plan.actions.filter((a) => a.type === "create");
    assert.equal(creates.length, 2);
    assert.ok(creates.every((a) => a.url.startsWith("https://")));
  });

  it("pins an existing unpinned matching tab instead of creating", () => {
    const plan = planRestore({
      savedUrls: ["https://mlh.com/"],
      bindings: {},
      tabs: [
        { id: 5, pinned: false, url: "https://mlh.com/", index: 0 },
      ],
    });
    assert.ok(plan.actions.some((a) => a.type === "pin" && a.tabId === 5));
    assert.equal(plan.actions.filter((a) => a.type === "create").length, 0);
  });

  it("isWindowAlreadySatisfied skips when recently restored with enough pins", () => {
    assert.equal(
      isWindowAlreadySatisfied({
        savedUrls: saved,
        pinnedTabs: [
          { id: 1, url: "https://mlh.com/x" },
          { id: 2, url: "https://hacktoberfest.com/y" },
        ],
        bindings: { "1": "mlh.com/", "2": "hacktoberfest.com/" },
        lastSatisfiedAt: Date.now() - 1000,
        now: Date.now(),
      }),
      true
    );
  });
});
