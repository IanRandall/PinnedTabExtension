import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPinToList,
  canonicalStoredUrl,
  dedupeUrlList,
  isRestrictedUrl,
  isWindowAlreadySatisfied,
  normalizeUrlKey,
  planRestore,
  removePinFromList,
  shouldDeferUnpinToOnRemoved,
  shouldPersistNavigatedUrl,
  shouldRemoveOnTabClosed,
  storageAfterClosingPins,
} from "../lib/pin-logic.js";

describe("1) explicit pin adds once; duplicate same URL does not grow", () => {
  it("adds a new pin URL once", () => {
    const a = addPinToList([], "https://hacktoberfest.com/");
    assert.equal(a.added, true);
    assert.equal(a.list.length, 1);
  });

  it("duplicate pin of same URL (http/https/slash) does not grow list", () => {
    let { list } = addPinToList([], "https://hacktoberfest.com/");
    ({ list } = addPinToList(list, "http://hacktoberfest.com"));
    ({ list } = addPinToList(list, "https://hacktoberfest.com"));
    assert.equal(list.length, 1);
  });
});

describe("2) unpin removes from storage", () => {
  it("removePinFromList drops the URL", () => {
    let list = addPinToList([], "https://a.example/").list;
    list = addPinToList(list, "https://b.example/").list;
    const out = removePinFromList(list, "https://a.example/");
    assert.equal(out.removed, true);
    assert.equal(out.list.length, 1);
    assert.match(out.list[0], /b\.example/);
  });
});

describe("3) close pinned tab while windows remain → remove", () => {
  it("shouldRemoveOnTabClosed is true when browser still open", () => {
    assert.equal(
      shouldRemoveOnTabClosed({
        isWindowClosing: false,
        browserStillOpen: true,
      }),
      true
    );
  });
});

describe("4) session ending / last window → storage preserved", () => {
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
        browserStillOpen: false,
      }),
      false
    );
  });
});

describe("5) restore empty window creates pins in saved order", () => {
  it("emits create actions in order", () => {
    const saved = [
      "https://mlh.com/",
      "https://hacktoberfest.com/",
      "https://example.com/docs",
    ];
    const plan = planRestore({
      savedUrls: saved,
      bindings: {},
      tabs: [{ id: 1, pinned: false, url: "about:blank", index: 0 }],
    });
    const creates = plan.actions.filter((a) => a.type === "create");
    assert.equal(creates.length, 3);
    assert.deepEqual(
      creates.map((a) => a.index),
      [0, 1, 2]
    );
    assert.equal(creates[0].url, "https://mlh.com/");
    assert.equal(creates[1].url, "https://hacktoberfest.com/");
    assert.equal(creates[2].url, "https://example.com/docs");
  });
});

describe("6) restore already-correct window is idempotent", () => {
  it("no create when bound pins already cover saved set", () => {
    const saved = ["https://mlh.com/", "https://hacktoberfest.com/"];
    const plan = planRestore({
      savedUrls: saved,
      bindings: { "1": "mlh.com/", "2": "hacktoberfest.com/" },
      tabs: [
        { id: 1, pinned: true, url: "https://mlh.com/", index: 0 },
        { id: 2, pinned: true, url: "https://hacktoberfest.com/", index: 1 },
      ],
    });
    assert.equal(plan.actions.filter((a) => a.type === "create").length, 0);
    assert.equal(plan.complete, true);
  });

  it("isWindowAlreadySatisfied when recently restored", () => {
    assert.equal(
      isWindowAlreadySatisfied({
        savedUrls: ["https://mlh.com/", "https://hacktoberfest.com/"],
        pinnedTabs: [
          { id: 1, url: "https://mlh.com/x" },
          { id: 2, url: "https://hacktoberfest.com/y" },
        ],
        bindings: { "1": "mlh.com/", "2": "hacktoberfest.com/" },
        lastSatisfiedAt: Date.now() - 500,
        now: Date.now(),
      }),
      true
    );
  });
});

describe("7) new window restore gets full set (Safari-style)", () => {
  it("empty second window gets creates for every saved URL", () => {
    const saved = ["https://a.example/", "https://b.example/"];
    const plan = planRestore({
      savedUrls: saved,
      bindings: {},
      tabs: [],
    });
    assert.equal(plan.actions.filter((a) => a.type === "create").length, 2);
  });
});

describe("8) restricted URLs skipped on save/restore", () => {
  it("isRestrictedUrl covers chrome/brave/about", () => {
    assert.equal(isRestrictedUrl("chrome://settings"), true);
    assert.equal(isRestrictedUrl("brave://extensions"), true);
    assert.equal(isRestrictedUrl("about:blank"), true);
    assert.equal(isRestrictedUrl("https://example.com"), false);
  });

  it("addPinToList rejects restricted URLs", () => {
    const out = addPinToList([], "chrome://newtab");
    assert.equal(out.added, false);
    assert.equal(out.list.length, 0);
  });

  it("planRestore skips restricted saved entries", () => {
    const plan = planRestore({
      savedUrls: ["chrome://settings", "https://ok.example/"],
      bindings: {},
      tabs: [],
    });
    const creates = plan.actions.filter((a) => a.type === "create");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].url, "https://ok.example/");
  });
});

describe("9) normal unpinned tab with stored URL does not auto-grow storage", () => {
  it("opening a matching unpinned tab is not a persist event", () => {
    assert.equal(
      shouldPersistNavigatedUrl({
        awaitingFirstPinUrl: false,
        changePinned: undefined,
      }),
      false
    );
    // Mid-session browsing: storage unchanged unless restore is filling a gap.
    let list = addPinToList([], "https://mlh.com/").list;
    // User opens history as normal tab — must not addPinToList again.
    const again = addPinToList(list, "https://mlh.com/");
    assert.equal(again.added, false);
    assert.equal(again.list.length, 1);
  });

  it("restore only pins matching unpinned tab when that slot is missing", () => {
    const plan = planRestore({
      savedUrls: ["https://mlh.com/"],
      bindings: {},
      tabs: [{ id: 5, pinned: false, url: "https://mlh.com/", index: 0 }],
    });
    assert.ok(plan.actions.some((a) => a.type === "pin" && a.tabId === 5));
    // If already covered by a bound pin, opening another unpinned match must not create.
    const covered = planRestore({
      savedUrls: ["https://mlh.com/"],
      bindings: { "9": "mlh.com/" },
      tabs: [
        { id: 9, pinned: true, url: "https://mlh.com/elsewhere", index: 0 },
        { id: 5, pinned: false, url: "https://mlh.com/", index: 1 },
      ],
    });
    assert.equal(covered.actions.filter((a) => a.type === "create").length, 0);
    assert.equal(covered.actions.filter((a) => a.type === "pin").length, 0);
  });
});

describe("10) navigating inside a pin does not grow storage", () => {
  it("shouldPersistNavigatedUrl is false for plain navigations", () => {
    const start = addPinToList([], "https://mlh.com/").list;
    let list = start;
    for (const url of [
      "https://mlh.com/challenges/1",
      "https://hacktoberfest.com/my",
    ]) {
      if (
        !shouldPersistNavigatedUrl({
          awaitingFirstPinUrl: false,
          changePinned: undefined,
        })
      ) {
        continue;
      }
      list = addPinToList(list, url).list;
    }
    assert.equal(list.length, 1);
  });

  it("deferred first URL after pin may persist once", () => {
    assert.equal(
      shouldPersistNavigatedUrl({ awaitingFirstPinUrl: true }),
      true
    );
    assert.equal(shouldPersistNavigatedUrl({ changePinned: true }), true);
  });
});

describe("11) restore does not close/reload navigated pins", () => {
  it("binds navigated pins instead of create/closeOrphan", () => {
    const saved = ["https://mlh.com/", "https://hacktoberfest.com/"];
    const plan = planRestore({
      savedUrls: saved,
      bindings: { "10": "mlh.com/" },
      tabs: [
        {
          id: 10,
          pinned: true,
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
    assert.equal(plan.actions.some((a) => a.type === "create"), false);
    assert.equal(
      plan.actions.some((a) =>
        ["navigate", "reload", "closeOrphan"].includes(a.type)
      ),
      false
    );
    assert.equal(plan.nextBindings["11"], "hacktoberfest.com/");
  });
});

describe("12) URL normalization edge cases", () => {
  it("trailing slash and http/https match", () => {
    assert.equal(
      normalizeUrlKey("https://Example.com/foo/"),
      normalizeUrlKey("http://example.com/foo")
    );
  });

  it("dedupes polluted list", () => {
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

  it("canonicalStoredUrl prefers https", () => {
    assert.equal(canonicalStoredUrl("http://x.example/a/"), "https://x.example/a");
  });
});

describe("close-pin resurrection (1.0.8 / Brave crash urgency)", () => {
  it("defer unpin-to-onRemoved when tab already gone (do not drop key early)", () => {
    assert.equal(
      shouldDeferUnpinToOnRemoved({ tabStillExists: false }),
      true
    );
    assert.equal(
      shouldDeferUnpinToOnRemoved({ tabStillExists: true }),
      false
    );
  });

  it("close pinned tabs then restore empty window → not recreated", () => {
    const before = [
      "https://mlh.com/",
      "https://hacktoberfest.com/",
      "https://keep.example/",
    ];
    const after = storageAfterClosingPins(before, [
      "https://mlh.com/",
      "https://hacktoberfest.com/",
    ]);
    assert.equal(after.length, 1);
    assert.match(after[0], /keep\.example/);

    const plan = planRestore({
      savedUrls: after,
      bindings: {},
      tabs: [],
    });
    const creates = plan.actions.filter((a) => a.type === "create");
    assert.equal(creates.length, 1);
    assert.match(creates[0].url, /keep\.example/);
    assert.equal(
      creates.some((a) => /mlh\.com|hacktoberfest/.test(a.url)),
      false
    );
  });

  it("suppressedKeys block recreate even if stale storage still lists them", () => {
    const stale = ["https://mlh.com/", "https://hacktoberfest.com/"];
    const plan = planRestore({
      savedUrls: stale,
      bindings: {},
      tabs: [],
      suppressedKeys: ["mlh.com/", "hacktoberfest.com/"],
    });
    assert.equal(plan.actions.filter((a) => a.type === "create").length, 0);
    assert.equal(plan.skipReason, "empty-saved");
  });

  it("close + scheduled restore cannot resurrect (storage cleared + suppress)", () => {
    const saved = ["https://a.example/", "https://b.example/"];
    const closed = ["https://a.example/", "https://b.example/"];
    const remaining = storageAfterClosingPins(saved, closed);
    assert.deepEqual(remaining, []);

    // Simulate delayed restore retries seeing empty/suppressed storage.
    for (let i = 0; i < 4; i++) {
      const plan = planRestore({
        savedUrls: remaining,
        suppressedKeys: closed.map((u) => normalizeUrlKey(u)),
        bindings: {},
        tabs: [{ id: 1, pinned: false, url: "https://other.example/", index: 0 }],
      });
      assert.equal(plan.actions.filter((a) => a.type === "create").length, 0);
      assert.equal(plan.actions.filter((a) => a.type === "pin").length, 0);
    }
  });

  it("user close still removes even if a restore flag were set (no isRestoring skip)", () => {
    // shouldRemoveOnTabClosed no longer takes isRestoring — closing must clear storage.
    assert.equal(
      shouldRemoveOnTabClosed({
        browserStillOpen: true,
        isWindowClosing: false,
      }),
      true
    );
  });
});
