import { describe, expect, it } from "vitest";

import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";
import {
  addDomainToState,
  getActiveBlockedSites,
  applyPendingRemovalsToState,
  applyPendingSettingsToState,
  buildDynamicRules,
  canAllow,
  cancelFocusSessionEnd,
  cancelSettingsChange,
  clearEndedFocusSession,
  doesHostnameMatchBlockedDomain,
  getBlockedDomainForUrl,
  getCurrentBlockWindow,
  getHostnameFromUrl,
  getNextBlockWindowStart,
  getNextPendingChangeAt,
  getWeekSegments,
  isFocusSessionActive,
  isInBlockWindow,
  isLikelyDomain,
  isPassOpen,
  isSiteEnforced,
  isWeakeningSettingsChange,
  normalizeDomain,
  queuePendingRemoval,
  queueSettingsChange,
  removeDomainFromState,
  requestFocusSessionEnd,
  setFocusOnly,
  startFocusSession,
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

    expect(getBlockedDomainForUrl("https://www.youtube.com/watch?v=123", blockedSites, [])).toBe(
      "youtube.com",
    );
    expect(getBlockedDomainForUrl("https://reddit.com/r/typescript", blockedSites, [])).toBe(
      "reddit.com",
    );
    expect(getBlockedDomainForUrl("https://news.ycombinator.com", blockedSites, [])).toBeNull();
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

  describe("getWeekSegments", () => {
    const bars = (windows: BlockWindow[], day: number) =>
      getWeekSegments(windows)[day]!.map(({ start, end, overnight }) => ({ start, end, overnight }));

    it("draws a same-day window as one bar on each of its days", () => {
      const morning: BlockWindow[] = [
        { label: "AM", days: [1, 3], startHour: 9, startMin: 0, endHour: 12, endMin: 30 },
      ];

      expect(bars(morning, 1)).toEqual([{ start: 540, end: 750, overnight: false }]);
      expect(bars(morning, 3)).toEqual([{ start: 540, end: 750, overnight: false }]);
      expect(bars(morning, 2)).toEqual([]);
    });

    it("splits an overnight window across its start day and the next", () => {
      const fridayNight: BlockWindow[] = [
        { label: "Late", days: [5], startHour: 22, startMin: 30, endHour: 7, endMin: 0 },
      ];

      expect(bars(fridayNight, 5)).toEqual([{ start: 1350, end: 1440, overnight: true }]);
      expect(bars(fridayNight, 6)).toEqual([{ start: 0, end: 420, overnight: true }]);
    });

    it("carries a Sunday-night window into Monday", () => {
      const sundayNight: BlockWindow[] = [
        { label: "Late", days: [0], startHour: 23, startMin: 0, endHour: 1, endMin: 0 },
      ];

      expect(bars(sundayNight, 0)).toEqual([{ start: 1380, end: 1440, overnight: true }]);
      expect(bars(sundayNight, 1)).toEqual([{ start: 0, end: 60, overnight: true }]);
    });

    it("draws equal start and end as 24 hours", () => {
      const fromNine: BlockWindow[] = [
        { label: "Day", days: [2], startHour: 9, startMin: 0, endHour: 9, endMin: 0 },
      ];
      const allMonday: BlockWindow[] = [
        { label: "All day", days: [1], startHour: 0, startMin: 0, endHour: 0, endMin: 0 },
      ];

      expect(bars(fromNine, 2)).toEqual([{ start: 540, end: 1440, overnight: true }]);
      expect(bars(fromNine, 3)).toEqual([{ start: 0, end: 540, overnight: true }]);
      expect(bars(allMonday, 1)).toEqual([{ start: 0, end: 1440, overnight: false }]);
      expect(bars(allMonday, 2)).toEqual([]);
    });

    it("stops a window that ends at 00:00 at midnight", () => {
      const evening: BlockWindow[] = [
        { label: "Eve", days: [4], startHour: 20, startMin: 0, endHour: 0, endMin: 0 },
      ];

      expect(bars(evening, 4)).toEqual([{ start: 1200, end: 1440, overnight: false }]);
      expect(bars(evening, 5)).toEqual([]);
    });

    it("sorts several windows on a day by start", () => {
      const windows: BlockWindow[] = [
        { label: "PM", days: [1], startHour: 14, startMin: 0, endHour: 17, endMin: 0 },
        { label: "Late", days: [0, 1], startHour: 22, startMin: 0, endHour: 7, endMin: 0 },
        { label: "AM", days: [1], startHour: 9, startMin: 0, endHour: 12, endMin: 0 },
      ];

      expect(getWeekSegments(windows)[1]!.map((s) => [s.window.label, s.start, s.end])).toEqual([
        ["Late", 0, 420],
        ["AM", 540, 720],
        ["PM", 840, 1020],
        ["Late", 1320, 1440],
      ]);
    });
  });

  describe("getNextBlockWindowStart", () => {
    // Defaults: Mon–Fri 09:00–12:00 and 14:00–17:00. 2026-03-16 is a Monday.
    it.each([
      ["before the first window today", "2026-03-16T08:00:00", "2026-03-16T09:00:00"],
      ["between today's windows", "2026-03-16T12:30:00", "2026-03-16T14:00:00"],
      ["exactly at a start, which is already running", "2026-03-16T09:00:00", "2026-03-16T14:00:00"],
      ["after Friday's last window", "2026-03-20T18:00:00", "2026-03-23T09:00:00"],
      ["on a Sunday", "2026-03-22T10:00:00", "2026-03-23T09:00:00"],
    ])("finds the next start %s", (_label, now, expected) => {
      const next = getNextBlockWindowStart(new Date(now), DEFAULT_BLOCK_WINDOWS);

      expect(next?.at).toEqual(new Date(expected));
    });

    it("looks a full week ahead for a window that only runs once a week", () => {
      const mondays: BlockWindow[] = [
        { label: "Weekly", days: [1], startHour: 9, startMin: 0, endHour: 10, endMin: 0 },
      ];

      const next = getNextBlockWindowStart(new Date("2026-03-16T09:30:00"), mondays);

      expect(next?.window.label).toBe("Weekly");
      expect(next?.at).toEqual(new Date("2026-03-23T09:00:00"));
    });

    it("returns null with no windows or no days", () => {
      const noDays: BlockWindow[] = [
        { label: "Never", days: [], startHour: 9, startMin: 0, endHour: 10, endMin: 0 },
      ];

      expect(getNextBlockWindowStart(new Date("2026-03-16T08:00:00"), [])).toBeNull();
      expect(getNextBlockWindowStart(new Date("2026-03-16T08:00:00"), noDays)).toBeNull();
    });
  });

  it("builds redirect rules for valid normalized domains only", () => {
    const rules = buildDynamicRules([
      " Reddit.com ",
      "https://www.youtube.com/watch?v=test",
      "reddit.com",
      "not-a-domain",
    ], []);

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
    const storage = testStorage({ blockedSites: ["reddit.com", "youtube.com"] });

    expect(getActiveBlockedSites(storage, new Date("2026-03-16T09:30:00"))).toEqual([
      "reddit.com",
      "youtube.com",
    ]);
    expect(getActiveBlockedSites(storage, new Date("2026-03-16T18:00:00"))).toEqual([]);
  });

  describe("a pass", () => {
    // Monday 09:30, inside the default morning window.
    const requestedAt = new Date("2026-03-16T09:30:00").getTime();
    const minute = 60_000;
    const blocked = testStorage({ blockedSites: ["reddit.com", "youtube.com"] });
    const withPass = queuePendingRemoval(blocked, "reddit.com", "one thread", requestedAt, 10 * minute, 15)
      .storage;
    const at = (minutes: number) => requestedAt + minutes * minute;
    const settle = (minutes: number) => applyPendingRemovalsToState(withPass, at(minutes));
    const activeAt = (minutes: number) => getActiveBlockedSites(settle(minutes), new Date(at(minutes)));

    it("ends its wait at the delay and re-blocks after its length", () => {
      expect(withPass.pendingRemovals[0]).toMatchObject({ applyAt: at(10), reblockAt: at(25) });
    });

    it.each([
      ["during the wait", 9, ["reddit.com", "youtube.com"]],
      ["the moment it opens", 10, ["youtube.com"]],
      ["just before it ends", 24.9, ["youtube.com"]],
      ["the moment it ends", 25, ["reddit.com", "youtube.com"]],
    ])("%s", (_label, minutes, expected) => {
      expect(activeAt(minutes)).toEqual(expected);
    });

    it("keeps the site on the list throughout, and leaves the queue only when it ends", () => {
      expect(settle(12)).toBe(withPass);
      expect(isPassOpen(withPass.pendingRemovals[0]!, at(12))).toBe(true);
      expect(settle(25).blockedSites).toEqual(["reddit.com", "youtube.com"]);
      expect(settle(25).pendingRemovals).toEqual([]);
    });

    it("leaves a removal with no length permanent", () => {
      const permanent = queuePendingRemoval(blocked, "reddit.com", "done with it", requestedAt, 10 * minute)
        .storage;

      expect(permanent.pendingRemovals[0]).not.toHaveProperty("reblockAt");
      expect(applyPendingRemovalsToState(permanent, at(10)).blockedSites).toEqual(["youtube.com"]);
    });

    it("reports the next moment anything is due", () => {
      expect(getNextPendingChangeAt(withPass, at(0))).toBe(at(10));
      expect(getNextPendingChangeAt(withPass, at(10))).toBe(at(25));
      expect(getNextPendingChangeAt(withPass, at(25))).toBeNull();
      expect(getNextPendingChangeAt(blocked, at(0))).toBeNull();
    });
  });

  describe("a focus session", () => {
    const minute = 60_000;
    // Monday: 09:30 is inside the default morning window, 18:00 is outside every window.
    const inWindow = new Date("2026-03-16T09:30:00");
    const outside = new Date("2026-03-16T18:00:00");
    const t = outside.getTime();
    const sites = testStorage({
      blockedSites: ["x.com", "mail.google.com"],
      focusOnlySites: ["mail.google.com"],
      frictionDelayMs: 10 * minute,
    });
    const started = startFocusSession(sites, 45, t);

    it("blocks focus-only sites too, in or out of a window", () => {
      expect(getActiveBlockedSites(started, outside)).toEqual(["x.com", "mail.google.com"]);
      expect(
        getActiveBlockedSites(startFocusSession(sites, 45, inWindow.getTime()), inWindow),
      ).toEqual(["x.com", "mail.google.com"]);
    });

    it("leaves focus-only sites open in a plain window, and blocks nothing outside both", () => {
      expect(getActiveBlockedSites(sites, inWindow)).toEqual(["x.com"]);
      expect(getActiveBlockedSites(sites, outside)).toEqual([]);
    });

    it("still respects an open pass", () => {
      const withPass = queuePendingRemoval(started, "x.com", "one post", t, 10 * minute, 15).storage;

      expect(getActiveBlockedSites(withPass, new Date(t + 12 * minute))).toEqual(["mail.google.com"]);
    });

    it("starts now and extends from its end", () => {
      expect(started.focusSession).toEqual({ endsAt: t + 45 * minute });
      expect(startFocusSession(started, 15, t + 5 * minute).focusSession).toEqual({
        endsAt: t + 60 * minute,
      });
    });

    it("pulls its end in for an early end, and cancelling puts it back", () => {
      const ending = requestFocusSessionEnd(started, " done ", t + 5 * minute);

      expect(ending.focusSession).toEqual({
        endsAt: t + 15 * minute,
        endingEarly: { reason: "done", originalEndsAt: t + 45 * minute },
      });
      expect(requestFocusSessionEnd(ending, "again", t + 6 * minute)).toBe(ending);
      expect(cancelFocusSessionEnd(ending).focusSession).toEqual({ endsAt: t + 45 * minute });
      expect(cancelFocusSessionEnd(started)).toBe(started);
    });

    it("refuses an early end the wait would not make sooner", () => {
      expect(requestFocusSessionEnd(started, "done", t + 40 * minute)).toBe(started);
      expect(requestFocusSessionEnd(sites, "done", t)).toBe(sites);
    });

    it("drops a pending early end when extended", () => {
      const ending = requestFocusSessionEnd(started, "done", t + 5 * minute);

      expect(startFocusSession(ending, 15, t + 6 * minute).focusSession).toEqual({
        endsAt: t + 60 * minute,
      });
    });

    it("is cleared once it ends", () => {
      expect(isFocusSessionActive(started, t + 45 * minute)).toBe(false);
      expect(clearEndedFocusSession(started, t + 44 * minute)).toBe(started);
      expect(clearEndedFocusSession(started, t + 45 * minute).focusSession).toBeNull();
      expect(clearEndedFocusSession(sites, t)).toBe(sites);
    });

    it("wakes the background when it ends", () => {
      expect(getNextPendingChangeAt(started, t)).toBe(t + 45 * minute);
    });

    it("flags only listed sites as focus only", () => {
      expect(setFocusOnly(sites, "x.com", true).focusOnlySites).toEqual(["mail.google.com", "x.com"]);
      expect(setFocusOnly(sites, "mail.google.com", false).focusOnlySites).toEqual([]);
      expect(setFocusOnly(sites, "mail.google.com", true)).toBe(sites);
      expect(setFocusOnly(sites, "reddit.com", true)).toBe(sites);
    });

    it("drops the flag when the site is removed", () => {
      const queued = queuePendingRemoval(sites, "mail.google.com", "done", t, 10 * minute).storage;

      expect(removeDomainFromState(sites, "mail.google.com").focusOnlySites).toEqual([]);
      expect(applyPendingRemovalsToState(queued, t + 10 * minute).focusOnlySites).toEqual([]);
    });

    it.each([
      ["in a session", started, outside, true, true],
      ["in a plain window", sites, inWindow, true, false],
      ["outside both", sites, outside, false, false],
    ])("enforces sites %s", (_label, storage, now, always, focusOnly) => {
      expect(isSiteEnforced(storage, "x.com", now)).toBe(always);
      expect(isSiteEnforced(storage, "mail.google.com", now)).toBe(focusOnly);
    });
  });

  describe("the allow list", () => {
    const minute = 60_000;
    // Monday: 09:30 is inside the default morning window.
    const inWindow = new Date("2026-03-16T09:30:00");
    const youtubeWithMusic = testStorage({
      blockedSites: ["youtube.com", "reddit.com"],
      allowedSites: ["music.youtube.com"],
    });

    it.each([
      ["a strict subdomain", "music.youtube.com", true],
      ["a deeper subdomain", "a.music.youtube.com", true],
      ["the blocked site itself", "youtube.com", false],
      ["another blocked site", "reddit.com", false],
      ["a parent of a blocked site", "google.com", false],
      ["an unrelated address", "news.ycombinator.com", false],
      ["not a domain", "music", false],
    ])("allows %s only when it sits inside a blocked site", (_label, domain, expected) => {
      expect(canAllow(domain, ["youtube.com", "reddit.com", "mail.google.com"])).toBe(expected);
    });

    it("refuses an address inside a blocked site that is blocked itself or contains one", () => {
      expect(canAllow("music.youtube.com", ["youtube.com", "music.youtube.com"])).toBe(false);
      expect(canAllow("music.youtube.com", ["youtube.com", "a.music.youtube.com"])).toBe(false);
    });

    it("leaves addresses under an allowed entry unmatched, and blocks the rest of the site", () => {
      const match = (url: string) =>
        getBlockedDomainForUrl(url, ["youtube.com"], ["music.youtube.com"]);

      expect(match("https://music.youtube.com/watch?v=1")).toBeNull();
      expect(match("https://foo.music.youtube.com/")).toBeNull();
      expect(match("https://m.youtube.com/")).toBe("youtube.com");
      expect(match("https://youtube.com/")).toBe("youtube.com");
      expect(match("https://www.youtube.com/")).toBe("youtube.com");
    });

    it("builds allow rules at priority 2 with unique ids, only under an actively blocked site", () => {
      const rules = buildDynamicRules(
        ["youtube.com", "reddit.com"],
        ["music.youtube.com", "old.reddit.com", "mail.google.com"],
      );
      const allowRules = rules.filter((rule) => rule.action.type === "allow");

      expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
      expect(rules.every((rule) => rule.id > 0)).toBe(true);
      expect(allowRules).toHaveLength(2);
      expect(allowRules[0]).toMatchObject({
        priority: 2,
        action: { type: "allow" },
        condition: { urlFilter: "||music.youtube.com^", resourceTypes: ["main_frame"] },
      });
      expect(allowRules[1]?.condition.urlFilter).toBe("||old.reddit.com^");
      expect(rules.filter((rule) => rule.priority === 1)).toHaveLength(2);
    });

    it("builds no rules at all when nothing is blocked", () => {
      expect(buildDynamicRules([], ["music.youtube.com"])).toEqual([]);
    });

    it("drops an allowed entry when that address gets blocked itself", () => {
      const next = addDomainToState(youtubeWithMusic, "music.youtube.com");

      expect(next.blockedSites).toContain("music.youtube.com");
      expect(next.allowedSites).toEqual([]);
    });

    it("drops orphaned entries when their site is removed, and keeps ones still covered", () => {
      const storage = testStorage({
        blockedSites: ["youtube.com", "reddit.com", "old.reddit.com"],
        allowedSites: ["music.youtube.com", "new.old.reddit.com"],
      });

      expect(removeDomainFromState(youtubeWithMusic, "youtube.com").allowedSites).toEqual([]);
      expect(removeDomainFromState(youtubeWithMusic, "reddit.com").allowedSites).toEqual([
        "music.youtube.com",
      ]);
      // new.old.reddit.com is still inside reddit.com once old.reddit.com goes.
      expect(removeDomainFromState(storage, "old.reddit.com").allowedSites).toEqual([
        "music.youtube.com",
        "new.old.reddit.com",
      ]);
    });

    it("drops orphaned entries when a queued removal applies", () => {
      const t = inWindow.getTime();
      const queued = queuePendingRemoval(youtubeWithMusic, "youtube.com", "done", t, 10 * minute)
        .storage;

      expect(applyPendingRemovalsToState(queued, t + 9 * minute).allowedSites).toEqual([
        "music.youtube.com",
      ]);
      expect(applyPendingRemovalsToState(queued, t + 10 * minute).allowedSites).toEqual([]);
    });

    it("keeps every entry through a pass, open or ended", () => {
      const t = inWindow.getTime();
      const withPass = queuePendingRemoval(youtubeWithMusic, "youtube.com", "one video", t, 10 * minute, 15)
        .storage;

      expect(applyPendingRemovalsToState(withPass, t + 12 * minute).allowedSites).toEqual([
        "music.youtube.com",
      ]);
      expect(applyPendingRemovalsToState(withPass, t + 25 * minute).allowedSites).toEqual([
        "music.youtube.com",
      ]);
    });
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
