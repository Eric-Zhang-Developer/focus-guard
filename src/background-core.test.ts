import { describe, expect, it } from "vitest";

import { DEFAULT_FRICTION_DELAY_MS } from "./config";
import {
  addDomainToState,
  getActiveBlockedSites,
  applyPendingRemovalsToState,
  applyPendingSettingsToState,
  buildDynamicRules,
  cancelSettingsChange,
  doesHostnameMatchBlockedDomain,
  getBlockedDomainForUrl,
  getCurrentBlockWindow,
  getHostnameFromUrl,
  isInBlockWindow,
  isLikelyDomain,
  isWeakeningSettingsChange,
  normalizeDomain,
  queuePendingRemoval,
  queueSettingsChange,
} from "./background-core";
import { DEFAULT_STORAGE } from "./types";
import type { BlockWindow, StorageSchema } from "./types";

function testStorage(overrides: Partial<StorageSchema> = {}): StorageSchema {
  return { ...DEFAULT_STORAGE, ...overrides };
}

describe("background-core", () => {
  it("normalizes domains defensively", () => {
    expect(normalizeDomain(" https://WWW.Reddit.com/r/typescript?q=1#top ")).toBe("reddit.com");
  });

  it.each([
    ["reddit.com:8080/r/all", "reddit.com"],
    ["*.reddit.com", "reddit.com"],
    ["user:pass@reddit.com", "reddit.com"],
    ["reddit.com.", "reddit.com"],
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["old.reddit.com", "old.reddit.com"],
  ])("normalizes %s to a hostname Chrome accepts in a rule", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
    expect(isLikelyDomain(normalizeDomain(input))).toBe(true);
  });

  it.each(["", "reddit", "red dit.com", "reddit.com,", "reddit.*", "ftp://reddit.com", "[::1]"])(
    "rejects %j as a domain",
    (input) => {
      expect(isLikelyDomain(normalizeDomain(input))).toBe(false);
    },
  );

  it("extracts normalized hostnames from supported tab URLs only", () => {
    expect(getHostnameFromUrl("https://m.youtube.com/watch?v=123")).toBe("m.youtube.com");
    expect(getHostnameFromUrl("chrome-extension://abc123/blocked.html")).toBeNull();
    expect(getHostnameFromUrl("not a url")).toBeNull();
  });

  it("matches blocked domains against apex domains and subdomains", () => {
    expect(doesHostnameMatchBlockedDomain("youtube.com", "youtube.com")).toBe(true);
    expect(doesHostnameMatchBlockedDomain("m.youtube.com", "youtube.com")).toBe(true);
    expect(doesHostnameMatchBlockedDomain("notyoutube.com", "youtube.com")).toBe(false);
  });

  it("finds the blocked domain for matching tab URLs", () => {
    const blockedSites = ["reddit.com", "youtube.com"];

    expect(getBlockedDomainForUrl("https://www.youtube.com/watch?v=123", blockedSites)).toBe(
      "youtube.com",
    );
    expect(getBlockedDomainForUrl("https://reddit.com/r/typescript", blockedSites)).toBe(
      "reddit.com",
    );
    expect(getBlockedDomainForUrl("https://news.ycombinator.com", blockedSites)).toBeNull();
  });

  it("detects whether the current time is inside a block window", () => {
    expect(isInBlockWindow(new Date("2026-03-16T09:30:00"))).toBe(true);
    expect(isInBlockWindow(new Date("2026-03-16T12:00:00"))).toBe(false);
  });

  it("returns the active block window when one exists", () => {
    expect(getCurrentBlockWindow(new Date("2026-03-16T14:15:00"))?.label).toBe(
      "Afternoon Focus",
    );
    expect(getCurrentBlockWindow(new Date("2026-03-16T18:00:00"))).toBeNull();
  });

  describe("windows that cross midnight", () => {
    // 2026-03-20 is a Friday.
    const fridayNight: BlockWindow[] = [
      { label: "Late", days: [5], startHour: 22, startMin: 0, endHour: 2, endMin: 0 },
    ];

    it.each([
      ["Friday 21:59", "2026-03-20T21:59:00", false],
      ["Friday 22:00", "2026-03-20T22:00:00", true],
      ["Friday 23:59", "2026-03-20T23:59:00", true],
      ["Saturday 01:59", "2026-03-21T01:59:00", true],
      ["Saturday 02:00", "2026-03-21T02:00:00", false],
      ["Saturday 22:30, a day that is not selected", "2026-03-21T22:30:00", false],
      ["Friday 01:00, because Thursday is not selected", "2026-03-20T01:00:00", false],
    ])("a Friday 22:00-02:00 window at %s", (_label, at, expected) => {
      expect(isInBlockWindow(new Date(at), fridayNight)).toBe(expected);
    });

    it("carries a Saturday-night window into Sunday", () => {
      const saturdayNight: BlockWindow[] = [
        { label: "Late", days: [6], startHour: 23, startMin: 0, endHour: 1, endMin: 0 },
      ];

      expect(isInBlockWindow(new Date("2026-03-22T00:30:00"), saturdayNight)).toBe(true);
    });

    it("treats equal start and end as a full 24 hours", () => {
      const allMonday: BlockWindow[] = [
        { label: "All day", days: [1], startHour: 0, startMin: 0, endHour: 0, endMin: 0 },
      ];

      expect(isInBlockWindow(new Date("2026-03-16T00:00:00"), allMonday)).toBe(true);
      expect(isInBlockWindow(new Date("2026-03-16T23:59:00"), allMonday)).toBe(true);
      expect(isInBlockWindow(new Date("2026-03-17T00:00:00"), allMonday)).toBe(false);
    });
  });

  it("builds redirect rules for valid normalized domains only", () => {
    const rules = buildDynamicRules([
      " Reddit.com ",
      "https://www.youtube.com/watch?v=test",
      "reddit.com",
      "not-a-domain",
    ]);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      id: 1,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: "/blocked.html?domain=reddit.com",
        },
      },
      condition: {
        urlFilter: "||reddit.com^",
        resourceTypes: ["main_frame"],
      },
    });
    expect(rules[1]?.condition.urlFilter).toBe("||youtube.com^");
    expect(rules[1]?.action.redirect?.extensionPath).toBe("/blocked.html?domain=youtube.com");
  });

  it("only exposes active blocked sites during a block window", () => {
    const sites = ["reddit.com", "youtube.com"];

    expect(getActiveBlockedSites(sites, undefined, new Date("2026-03-16T09:30:00"))).toEqual(
      sites,
    );
    expect(getActiveBlockedSites(sites, undefined, new Date("2026-03-16T18:00:00"))).toEqual([]);
  });

  it("adds blocked domains idempotently and clears pending removals for the same domain", () => {
    const queued = queuePendingRemoval(
      testStorage({
        blockedSites: ["reddit.com"],
        pendingRemovals: [],
      }),
      "reddit.com",
      "Need this later",
      1_000,
    );

    const nextState = addDomainToState(queued.storage, "reddit.com");

    expect(nextState).toMatchObject({
      blockedSites: ["reddit.com"],
      pendingRemovals: [],
    });
  });

  it("queues pending removals idempotently", () => {
    const firstQueue = queuePendingRemoval(
      testStorage({
        blockedSites: ["reddit.com"],
        pendingRemovals: [],
      }),
      "reddit.com",
      "Need this for work",
      10_000,
    );
    const secondQueue = queuePendingRemoval(
      firstQueue.storage,
      "reddit.com",
      "A different reason",
      20_000,
    );

    expect(firstQueue.applyAt).toBe(10_000 + DEFAULT_FRICTION_DELAY_MS);
    expect(secondQueue.applyAt).toBe(firstQueue.applyAt);
    expect(secondQueue.storage.pendingRemovals).toHaveLength(1);
  });

  it("applies only expired pending removals", () => {
    const storage = testStorage({
      blockedSites: ["reddit.com", "youtube.com"],
      pendingRemovals: [
        {
          domain: "reddit.com",
          reason: "Later",
          scheduledAt: 0,
          applyAt: 5_000,
        },
        {
          domain: "youtube.com",
          reason: "Soon",
          scheduledAt: 0,
          applyAt: 15_000,
        },
      ],
    });

    expect(applyPendingRemovalsToState(storage, 10_000)).toMatchObject({
      blockedSites: ["youtube.com"],
      pendingRemovals: [
        {
          domain: "youtube.com",
          reason: "Soon",
          scheduledAt: 0,
          applyAt: 15_000,
        },
      ],
    });
  });

  it("returns the same storage reference when no pending removals have expired", () => {
    expect(applyPendingRemovalsToState(DEFAULT_STORAGE, 10_000)).toBe(DEFAULT_STORAGE);
  });

  // ── isWeakeningSettingsChange ──────────────────────────────────────────────

  describe("isWeakeningSettingsChange", () => {
    const window1: BlockWindow = {
      label: "Work",
      days: [1, 2, 3, 4, 5],
      startHour: 9,
      startMin: 0,
      endHour: 17,
      endMin: 0,
    };
    const current = testStorage({ blockWindows: [window1], frictionDelayMs: 600_000 });

    it("returns true when frictionDelayMs is reduced", () => {
      expect(isWeakeningSettingsChange(current, { blockWindows: [window1], frictionDelayMs: 300_000 })).toBe(true);
    });

    it("returns true when a block window is removed", () => {
      expect(isWeakeningSettingsChange(current, { blockWindows: [], frictionDelayMs: 600_000 })).toBe(true);
    });

    it("returns true when an existing window is modified", () => {
      const modified = { ...window1, endHour: 16 };
      expect(isWeakeningSettingsChange(current, { blockWindows: [modified], frictionDelayMs: 600_000 })).toBe(true);
    });

    it("returns false when a new window is added", () => {
      const extraWindow: BlockWindow = {
        label: "Eve",
        days: [1],
        startHour: 18,
        startMin: 0,
        endHour: 20,
        endMin: 0,
      };
      expect(isWeakeningSettingsChange(current, { blockWindows: [window1, extraWindow], frictionDelayMs: 600_000 })).toBe(false);
    });

    it("returns false when frictionDelayMs is increased", () => {
      expect(isWeakeningSettingsChange(current, { blockWindows: [window1], frictionDelayMs: 900_000 })).toBe(false);
    });

    it("returns false when settings are unchanged", () => {
      expect(isWeakeningSettingsChange(current, { blockWindows: [window1], frictionDelayMs: 600_000 })).toBe(false);
    });
  });

  // ── queueSettingsChange ────────────────────────────────────────────────────

  describe("queueSettingsChange", () => {
    const newWindows: BlockWindow[] = [
      { label: "New", days: [1], startHour: 8, startMin: 0, endHour: 10, endMin: 0 },
    ];

    it("queues a pendingSettingsChange with correct applyAt", () => {
      const storage = testStorage({ frictionDelayMs: 600_000 });
      const { storage: next, applyAt } = queueSettingsChange(storage, newWindows, 300_000, "reason", 1_000);
      expect(applyAt).toBe(1_000 + 600_000);
      expect(next.pendingSettingsChange).not.toBeNull();
      expect(next.pendingSettingsChange!.applyAt).toBe(1_000 + 600_000);
    });

    it("stores proposed blockWindows and frictionDelayMs in pending change", () => {
      const storage = testStorage({ frictionDelayMs: 600_000 });
      const { storage: next } = queueSettingsChange(storage, newWindows, 300_000, "a reason", 1_000);
      expect(next.pendingSettingsChange!.blockWindows).toEqual(newWindows);
      expect(next.pendingSettingsChange!.frictionDelayMs).toBe(300_000);
    });
  });

  // ── cancelSettingsChange ───────────────────────────────────────────────────

  describe("cancelSettingsChange", () => {
    it("clears pendingSettingsChange", () => {
      const { storage: withPending } = queueSettingsChange(DEFAULT_STORAGE, [], 600_000, "r", 0);
      expect(withPending.pendingSettingsChange).not.toBeNull();
      const cancelled = cancelSettingsChange(withPending);
      expect(cancelled.pendingSettingsChange).toBeNull();
    });

    it("returns same reference when nothing was pending", () => {
      expect(cancelSettingsChange(DEFAULT_STORAGE)).toBe(DEFAULT_STORAGE);
    });
  });

  // ── applyPendingSettingsToState ────────────────────────────────────────────

  describe("applyPendingSettingsToState", () => {
    const newWindows: BlockWindow[] = [
      { label: "New", days: [1], startHour: 8, startMin: 0, endHour: 10, endMin: 0 },
    ];

    it("applies pending change when applyAt <= nowMs", () => {
      const { storage: withPending } = queueSettingsChange(DEFAULT_STORAGE, newWindows, 300_000, "r", 0);
      const applied = applyPendingSettingsToState(withPending, 600_001);
      expect(applied.blockWindows).toEqual(newWindows);
      expect(applied.frictionDelayMs).toBe(300_000);
      expect(applied.pendingSettingsChange).toBeNull();
    });

    it("does not apply pending change when applyAt > nowMs", () => {
      const { storage: withPending } = queueSettingsChange(DEFAULT_STORAGE, newWindows, 300_000, "r", 0);
      const result = applyPendingSettingsToState(withPending, 1_000);
      expect(result).toBe(withPending);
    });

    it("returns same reference when nothing is pending", () => {
      expect(applyPendingSettingsToState(DEFAULT_STORAGE, 999_999)).toBe(DEFAULT_STORAGE);
    });
  });
});
