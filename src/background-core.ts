import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";
import type { BlockWindow, PendingRemoval, PendingSettingsChange, StorageSchema } from "./types";

const REDIRECT_ACTION = "redirect" as chrome.declarativeNetRequest.RuleActionType;
const MAIN_FRAME_RESOURCE =
  "main_frame" as chrome.declarativeNetRequest.ResourceType;

function toMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export function normalizeDomain(rawDomain: string): string {
  const trimmedDomain = rawDomain.trim().toLowerCase();
  const withoutProtocol = trimmedDomain.replace(/^https?:\/\//, "");
  const withoutWww = withoutProtocol.replace(/^www\./, "");
  const withoutHash = withoutWww.split("#")[0] ?? "";
  const withoutQuery = withoutHash.split("?")[0] ?? "";
  const domainOnly = withoutQuery.split("/")[0] ?? "";

  return domainOnly.replace(/^\.+|\.+$/g, "");
}

export function isLikelyDomain(domain: string): boolean {
  return domain.includes(".") && !/\s/.test(domain);
}

export function getCurrentBlockWindow(
  now: Date = new Date(),
  windows: BlockWindow[] = DEFAULT_BLOCK_WINDOWS,
): BlockWindow | null {
  const day = now.getDay();
  const currentMinutes = toMinutes(now.getHours(), now.getMinutes());

  return (
    windows.find((window) => {
      if (!window.days.includes(day as BlockWindow["days"][number])) {
        return false;
      }

      const startMinutes = toMinutes(window.startHour, window.startMin);
      const endMinutes = toMinutes(window.endHour, window.endMin);

      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }) ?? null
  );
}

export function isInBlockWindow(
  now: Date = new Date(),
  windows: BlockWindow[] = DEFAULT_BLOCK_WINDOWS,
): boolean {
  return getCurrentBlockWindow(now, windows) !== null;
}

export function buildDynamicRules(domains: string[]): chrome.declarativeNetRequest.Rule[] {
  const normalizedDomains = [...new Set(domains.map(normalizeDomain).filter(isLikelyDomain))];

  return normalizedDomains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: REDIRECT_ACTION,
      redirect: {
        extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}`,
      },
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: [MAIN_FRAME_RESOURCE],
    },
  }));
}

export function addDomainToState(storage: StorageSchema, domain: string): StorageSchema {
  const normalizedDomain = normalizeDomain(domain);

  if (!isLikelyDomain(normalizedDomain)) {
    return storage;
  }

  const blockedSites = storage.blockedSites.includes(normalizedDomain)
    ? storage.blockedSites
    : [...storage.blockedSites, normalizedDomain];
  const pendingRemovals = storage.pendingRemovals.filter(
    (pendingRemoval) => pendingRemoval.domain !== normalizedDomain,
  );

  if (
    blockedSites === storage.blockedSites &&
    pendingRemovals.length === storage.pendingRemovals.length
  ) {
    return storage;
  }

  return {
    blockedSites,
    pendingRemovals,
  };
}

export function removeDomainFromState(storage: StorageSchema, domain: string): StorageSchema {
  const normalizedDomain = normalizeDomain(domain);
  const blockedSites = storage.blockedSites.filter((blockedSite) => blockedSite !== normalizedDomain);
  const pendingRemovals = storage.pendingRemovals.filter(
    (pendingRemoval) => pendingRemoval.domain !== normalizedDomain,
  );

  if (
    blockedSites.length === storage.blockedSites.length &&
    pendingRemovals.length === storage.pendingRemovals.length
  ) {
    return storage;
  }

  return {
    blockedSites,
    pendingRemovals,
  };
}

export function queuePendingRemoval(
  storage: StorageSchema,
  domain: string,
  reason: string,
  nowMs: number = Date.now(),
  delayMs: number = DEFAULT_FRICTION_DELAY_MS,
): { storage: StorageSchema; applyAt: number } {
  const normalizedDomain = normalizeDomain(domain);
  const existingPendingRemoval = storage.pendingRemovals.find(
    (pendingRemoval) => pendingRemoval.domain === normalizedDomain,
  );

  if (existingPendingRemoval) {
    return {
      storage,
      applyAt: existingPendingRemoval.applyAt,
    };
  }

  const scheduledAt = nowMs;
  const applyAt = scheduledAt + delayMs;
  const pendingRemoval: PendingRemoval = {
    domain: normalizedDomain,
    reason: reason.trim(),
    scheduledAt,
    applyAt,
  };

  return {
    storage: {
      blockedSites: storage.blockedSites,
      pendingRemovals: [...storage.pendingRemovals, pendingRemoval],
    },
    applyAt,
  };
}

export function cancelPendingRemoval(storage: StorageSchema, domain: string): StorageSchema {
  const normalizedDomain = normalizeDomain(domain);
  const pendingRemovals = storage.pendingRemovals.filter(
    (pendingRemoval) => pendingRemoval.domain !== normalizedDomain,
  );

  if (pendingRemovals.length === storage.pendingRemovals.length) {
    return storage;
  }

  return {
    blockedSites: storage.blockedSites,
    pendingRemovals,
  };
}

export function isWeakeningSettingsChange(
  current: StorageSchema,
  proposed: { blockWindows: BlockWindow[]; frictionDelayMs: number },
): boolean {
  if (proposed.frictionDelayMs < current.frictionDelayMs) {
    return true;
  }

  if (proposed.blockWindows.length < current.blockWindows.length) {
    return true;
  }

  // Check if any existing window was modified (by comparing serialized values)
  const currentSerialized = current.blockWindows.map((w) => JSON.stringify(w));
  return proposed.blockWindows.some((w) => !currentSerialized.includes(JSON.stringify(w)));
}

export function queueSettingsChange(
  storage: StorageSchema,
  blockWindows: BlockWindow[],
  frictionDelayMs: number,
  reason: string,
  nowMs: number = Date.now(),
): { storage: StorageSchema; applyAt: number } {
  const applyAt = nowMs + storage.frictionDelayMs;
  const pendingSettingsChange: PendingSettingsChange = {
    blockWindows,
    frictionDelayMs,
    reason: reason.trim(),
    scheduledAt: nowMs,
    applyAt,
  };

  return {
    storage: { ...storage, pendingSettingsChange },
    applyAt,
  };
}

export function cancelSettingsChange(storage: StorageSchema): StorageSchema {
  if (storage.pendingSettingsChange === null) {
    return storage;
  }

  return { ...storage, pendingSettingsChange: null };
}

export function applyPendingSettingsToState(
  storage: StorageSchema,
  nowMs: number = Date.now(),
): StorageSchema {
  const pending = storage.pendingSettingsChange;

  if (pending === null || pending.applyAt > nowMs) {
    return storage;
  }

  return {
    ...storage,
    blockWindows: pending.blockWindows,
    frictionDelayMs: pending.frictionDelayMs,
    pendingSettingsChange: null,
  };
}

export function applyPendingRemovalsToState(
  storage: StorageSchema,
  nowMs: number = Date.now(),
): StorageSchema {
  const expiredDomains = new Set(
    storage.pendingRemovals
      .filter((pendingRemoval) => pendingRemoval.applyAt <= nowMs)
      .map((pendingRemoval) => pendingRemoval.domain),
  );

  if (expiredDomains.size === 0) {
    return storage;
  }

  return {
    blockedSites: storage.blockedSites.filter((blockedSite) => !expiredDomains.has(blockedSite)),
    pendingRemovals: storage.pendingRemovals.filter(
      (pendingRemoval) => pendingRemoval.applyAt > nowMs,
    ),
  };
}
