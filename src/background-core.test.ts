import { describe, expect, it } from "vitest";

import { FRICTION_DELAY_MS } from "./config";
import {
  addDomainToState,
  applyPendingRemovalsToState,
  buildDynamicRules,
  getCurrentBlockWindow,
  isInBlockWindow,
  normalizeDomain,
  queuePendingRemoval,
} from "./background-core";
import { DEFAULT_STORAGE } from "./types";

describe("background-core", () => {
  it("normalizes domains defensively", () => {
    expect(normalizeDomain(" https://WWW.Reddit.com/r/typescript?q=1#top ")).toBe("reddit.com");
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
          extensionPath: "/blocked.html",
        },
      },
      condition: {
        urlFilter: "||reddit.com^",
        resourceTypes: ["main_frame"],
      },
    });
    expect(rules[1]?.condition.urlFilter).toBe("||youtube.com^");
  });

  it("adds blocked domains idempotently and clears pending removals for the same domain", () => {
    const queued = queuePendingRemoval(
      {
        blockedSites: ["reddit.com"],
        pendingRemovals: [],
      },
      "reddit.com",
      "Need this later",
      1_000,
    );

    const nextState = addDomainToState(queued.storage, "reddit.com");

    expect(nextState).toEqual({
      blockedSites: ["reddit.com"],
      pendingRemovals: [],
    });
  });

  it("queues pending removals idempotently", () => {
    const firstQueue = queuePendingRemoval(
      {
        blockedSites: ["reddit.com"],
        pendingRemovals: [],
      },
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

    expect(firstQueue.applyAt).toBe(10_000 + FRICTION_DELAY_MS);
    expect(secondQueue.applyAt).toBe(firstQueue.applyAt);
    expect(secondQueue.storage.pendingRemovals).toHaveLength(1);
  });

  it("applies only expired pending removals", () => {
    const storage = {
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
    };

    expect(applyPendingRemovalsToState(storage, 10_000)).toEqual({
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
});
