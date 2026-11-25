import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";
import type { BlockWindow, DayOfWeek, PendingRemoval, PendingSettingsChange, StorageSchema } from "./types";

const REDIRECT_ACTION = "redirect" as chrome.declarativeNetRequest.RuleActionType;
const ALLOW_ACTION = "allow" as chrome.declarativeNetRequest.RuleActionType;
const MAIN_FRAME_RESOURCE =
  "main_frame" as chrome.declarativeNetRequest.ResourceType;
const TAB_MATCH_PROTOCOLS = new Set(["http:", "https:"]);

function toMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export function normalizeDomain(rawDomain: string): string {
  // "*.reddit.com" asks for what "reddit.com" already does: the rule covers subdomains.
  // Strip it before parsing, because Chrome's URL parser escapes "*" where Node's keeps it.
  const withoutScheme = rawDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(\*\.)+/, "");
  let hostname: string;

  try {
    // The URL parser lowercases, drops ports, paths and credentials, and punycodes
    // non-ASCII hosts. Chrome rejects a rule whose urlFilter is not plain ASCII.
    hostname = new URL(`https://${withoutScheme}`).hostname;
  } catch {
    return "";
  }

  return hostname.replace(/^www\./, "").replace(/^\.+|\.+$/g, "");
}

export function getHostnameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (!TAB_MATCH_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }

    return normalizeDomain(parsed.hostname);
  } catch {
    return null;
  }
}

export function isLikelyDomain(domain: string): boolean {
  // Strict on purpose: Chrome applies a rule update all-or-nothing, so one entry it
  // rejects would stop every other site from being blocked.
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(domain);
}

export function doesHostnameMatchBlockedDomain(hostname: string, blockedDomain: string): boolean {
  const normalizedHostname = normalizeDomain(hostname);
  const normalizedBlockedDomain = normalizeDomain(blockedDomain);

  if (!isLikelyDomain(normalizedHostname) || !isLikelyDomain(normalizedBlockedDomain)) {
    return false;
  }

  return (
    normalizedHostname === normalizedBlockedDomain ||
    normalizedHostname.endsWith(`.${normalizedBlockedDomain}`)
  );
}

// An allowed entry must sit strictly inside a blocked site and must not equal or contain
// one, so an exception can never quietly switch a whole block off.
export function canAllow(domain: string, blockedSites: string[]): boolean {
  return (
    !blockedSites.some((site) => doesHostnameMatchBlockedDomain(site, domain)) &&
    blockedSites.some((site) => doesHostnameMatchBlockedDomain(domain, site))
  );
}

export function getBlockedDomainForUrl(
  url: string,
  blockedSites: string[],
  allowedSites: string[],
): string | null {
  const hostname = getHostnameFromUrl(url);

  if (
    hostname === null ||
    allowedSites.some((allowed) => doesHostnameMatchBlockedDomain(hostname, allowed))
  ) {
    return null;
  }

  return (
    blockedSites.find((blockedSite) => doesHostnameMatchBlockedDomain(hostname, blockedSite)) ?? null
  );
}

export function getCurrentBlockWindow(
  now: Date = new Date(),
  windows: BlockWindow[] = DEFAULT_BLOCK_WINDOWS,
): BlockWindow | null {
  const day = now.getDay();
  const currentMinutes = toMinutes(now.getHours(), now.getMinutes());

  return (
    windows.find((window) => {
      const startMinutes = toMinutes(window.startHour, window.startMin);
      const endMinutes = toMinutes(window.endHour, window.endMin);
      const startsToday = window.days.includes(day as DayOfWeek);

      if (startMinutes < endMinutes) {
        return startsToday && currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }

      // An end at or before the start runs past midnight; equal times are a full 24 hours.
      // `days` names the day a window starts on, so its early-morning part is active when
      // the day before is selected.
      const startedYesterday = window.days.includes(((day + 6) % 7) as DayOfWeek);

      return (
        (startsToday && currentMinutes >= startMinutes) ||
        (startedYesterday && currentMinutes < endMinutes)
      );
    }) ?? null
  );
}

export function isInBlockWindow(
  now: Date = new Date(),
  windows: BlockWindow[] = DEFAULT_BLOCK_WINDOWS,
): boolean {
  return getCurrentBlockWindow(now, windows) !== null;
}

export interface DaySegment {
  window: BlockWindow;
  start: number; // minutes after midnight
  end: number; // minutes after midnight, up to 1440
  overnight: boolean; // one half of a window that runs past midnight
}

// Same reading as getCurrentBlockWindow: an end at or before the start runs into the next
// day, except an end of 00:00, which stops at midnight.
export function crossesMidnight(window: BlockWindow): boolean {
  const end = toMinutes(window.endHour, window.endMin);

  return end > 0 && end <= toMinutes(window.startHour, window.startMin);
}

// The bars of the week view, one list per day indexed like Date.getDay(), sorted by start.
// A window that crosses midnight is start→24:00 on the day it starts and 00:00→end on the next.
export function getWeekSegments(windows: BlockWindow[]): DaySegment[][] {
  const week: DaySegment[][] = [[], [], [], [], [], [], []];

  for (const window of windows) {
    const start = toMinutes(window.startHour, window.startMin);
    const end = toMinutes(window.endHour, window.endMin);
    const overnight = crossesMidnight(window);

    for (const day of window.days) {
      week[day].push({ window, start, end: end > start ? end : 24 * 60, overnight });

      if (overnight) {
        week[(day + 1) % 7].push({ window, start: 0, end, overnight });
      }
    }
  }

  for (const segments of week) {
    segments.sort((a, b) => a.start - b.start);
  }

  return week;
}

// When the next scheduled window starts, looking up to a week ahead.
export function getNextBlockWindowStart(
  now: Date,
  windows: BlockWindow[],
): { window: BlockWindow; at: Date } | null {
  let next: { window: BlockWindow; at: Date } | null = null;

  for (let offset = 0; offset <= 7; offset++) {
    const day = ((now.getDay() + offset) % 7) as DayOfWeek;

    for (const window of windows) {
      if (!window.days.includes(day)) continue;

      // Built from calendar fields, not by adding milliseconds, so a DST change keeps 09:00 at 09:00.
      const at = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offset,
        window.startHour,
        window.startMin,
      );

      if (at > now && (next === null || at < next.at)) {
        next = { window, at };
      }
    }
  }

  return next;
}

export function isPassOpen(removal: PendingRemoval, nowMs: number = Date.now()): boolean {
  return removal.reblockAt !== undefined && removal.applyAt <= nowMs && nowMs < removal.reblockAt;
}

export function isFocusSessionActive(
  storage: Pick<StorageSchema, "focusSession">,
  nowMs: number = Date.now(),
): boolean {
  return storage.focusSession !== null && nowMs < storage.focusSession.endsAt;
}

// Whether weakening changes cost friction right now.
export function isBlockingNow(
  storage: Pick<StorageSchema, "focusSession" | "blockWindows">,
  now: Date = new Date(),
): boolean {
  return isFocusSessionActive(storage, now.getTime()) || isInBlockWindow(now, storage.blockWindows);
}

// Whether removing this site costs friction right now: a focus-only site is not blocked in
// a plain scheduled window, so it can go instantly there.
export function isSiteEnforced(
  storage: Pick<StorageSchema, "focusSession" | "blockWindows" | "focusOnlySites">,
  domain: string,
  now: Date = new Date(),
): boolean {
  return (
    isFocusSessionActive(storage, now.getTime()) ||
    (isInBlockWindow(now, storage.blockWindows) && !storage.focusOnlySites.includes(domain))
  );
}

// The one answer to "what is blocked right now": nothing outside a window or session; in a
// session the whole list, in a window only the list minus focus-only sites; and in both,
// minus any site with an open pass. Rules and tab checks both read this.
export function getActiveBlockedSites(
  storage: Pick<
    StorageSchema,
    "blockedSites" | "blockWindows" | "pendingRemovals" | "focusOnlySites" | "focusSession"
  >,
  now: Date = new Date(),
): string[] {
  const inSession = isFocusSessionActive(storage, now.getTime());

  if (!inSession && !isInBlockWindow(now, storage.blockWindows)) {
    return [];
  }

  const openDomains = new Set(
    storage.pendingRemovals
      .filter((removal) => isPassOpen(removal, now.getTime()))
      .map((removal) => removal.domain),
  );

  return storage.blockedSites.filter(
    (site) => !openDomains.has(site) && (inSession || !storage.focusOnlySites.includes(site)),
  );
}

// When the next queued change is due, so the background can wake exactly then instead of
// on its once-a-minute tick.
export function getNextPendingChangeAt(
  storage: Pick<StorageSchema, "pendingRemovals" | "pendingSettingsChange" | "focusSession">,
  nowMs: number = Date.now(),
): number | null {
  const upcoming = [
    ...storage.pendingRemovals.flatMap((removal) => [removal.applyAt, removal.reblockAt]),
    storage.pendingSettingsChange?.applyAt,
    storage.focusSession?.endsAt,
  ].filter((time): time is number => time !== undefined && time > nowMs);

  return upcoming.length > 0 ? Math.min(...upcoming) : null;
}

export function buildDynamicRules(
  domains: string[],
  allowedSites: string[],
): chrome.declarativeNetRequest.Rule[] {
  const normalizedDomains = [...new Set(domains.map(normalizeDomain).filter(isLikelyDomain))];
  // Only exceptions inside a site blocked right now; with nothing blocked there is nothing to except.
  const allowedDomains = [
    ...new Set(allowedSites.map(normalizeDomain).filter(isLikelyDomain)),
  ].filter((domain) => canAllow(domain, normalizedDomains));

  const redirectRules = normalizedDomains.map((domain, index) => ({
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

  // Higher priority than the redirects, so allow wins over block.
  const allowRules = allowedDomains.map((domain, index) => ({
    id: normalizedDomains.length + index + 1,
    priority: 2,
    action: { type: ALLOW_ACTION },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: [MAIN_FRAME_RESOURCE],
    },
  }));

  return [...redirectRules, ...allowRules];
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
    ...storage,
    blockedSites,
    pendingRemovals,
    // Blocking an allowed address explicitly wins over the exception.
    allowedSites: storage.allowedSites.filter((site) => canAllow(site, blockedSites)),
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
    ...storage,
    blockedSites,
    pendingRemovals,
    // Otherwise a site removed and added back later would quietly return as focus only.
    focusOnlySites: storage.focusOnlySites.filter((site) => site !== normalizedDomain),
    allowedSites: storage.allowedSites.filter((site) => canAllow(site, blockedSites)),
  };
}

export function queuePendingRemoval(
  storage: StorageSchema,
  domain: string,
  reason: string,
  nowMs: number = Date.now(),
  delayMs: number = DEFAULT_FRICTION_DELAY_MS,
  passMinutes?: number,
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
    ...(passMinutes === undefined ? {} : { reblockAt: applyAt + passMinutes * 60_000 }),
  };

  return {
    storage: {
      ...storage,
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
    ...storage,
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

  // Check if any existing window was removed or modified (by comparing serialized values)
  const proposedSerialized = proposed.blockWindows.map((w) => JSON.stringify(w));
  return current.blockWindows.some((w) => !proposedSerialized.includes(JSON.stringify(w)));
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
  // A pass stays queued while it is open, so its end can be seen; everything else leaves
  // the queue once it is due.
  const pendingRemovals = storage.pendingRemovals.filter(
    (removal) =>
      removal.applyAt > nowMs || (removal.reblockAt !== undefined && removal.reblockAt > nowMs),
  );

  if (pendingRemovals.length === storage.pendingRemovals.length) {
    return storage;
  }

  // Only a removal with no end takes the site off the list. An ended pass just leaves the queue.
  const removedDomains = new Set(
    storage.pendingRemovals
      .filter((removal) => removal.applyAt <= nowMs && removal.reblockAt === undefined)
      .map((removal) => removal.domain),
  );

  const blockedSites = storage.blockedSites.filter((blockedSite) => !removedDomains.has(blockedSite));

  return {
    ...storage,
    blockedSites,
    pendingRemovals,
    focusOnlySites: storage.focusOnlySites.filter((site) => !removedDomains.has(site)),
    allowedSites: storage.allowedSites.filter((site) => canAllow(site, blockedSites)),
  };
}

// Starts a session, or extends a running one from its real end. Extending only strengthens,
// so it also drops a pending early end.
export function startFocusSession(
  storage: StorageSchema,
  minutes: number,
  nowMs: number = Date.now(),
): StorageSchema {
  const session = isFocusSessionActive(storage, nowMs) ? storage.focusSession : null;
  const from = session === null ? nowMs : (session.endingEarly?.originalEndsAt ?? session.endsAt);

  return { ...storage, focusSession: { endsAt: from + minutes * 60_000 } };
}

export function requestFocusSessionEnd(
  storage: StorageSchema,
  reason: string,
  nowMs: number = Date.now(),
): StorageSchema {
  const session = storage.focusSession;
  const endsAt = nowMs + storage.frictionDelayMs;

  // A wait that would not end it sooner also covers a session that has already ended.
  if (session === null || session.endingEarly !== undefined || endsAt >= session.endsAt) {
    return storage;
  }

  return {
    ...storage,
    focusSession: { endsAt, endingEarly: { reason: reason.trim(), originalEndsAt: session.endsAt } },
  };
}

export function cancelFocusSessionEnd(storage: StorageSchema): StorageSchema {
  const endingEarly = storage.focusSession?.endingEarly;

  if (endingEarly === undefined) {
    return storage;
  }

  return { ...storage, focusSession: { endsAt: endingEarly.originalEndsAt } };
}

export function clearEndedFocusSession(
  storage: StorageSchema,
  nowMs: number = Date.now(),
): StorageSchema {
  if (storage.focusSession === null || storage.focusSession.endsAt > nowMs) {
    return storage;
  }

  return { ...storage, focusSession: null };
}

export function setFocusOnly(
  storage: StorageSchema,
  domain: string,
  focusOnly: boolean,
): StorageSchema {
  const normalizedDomain = normalizeDomain(domain);

  if (
    !storage.blockedSites.includes(normalizedDomain) ||
    storage.focusOnlySites.includes(normalizedDomain) === focusOnly
  ) {
    return storage;
  }

  return {
    ...storage,
    focusOnlySites: focusOnly
      ? [...storage.focusOnlySites, normalizedDomain]
      : storage.focusOnlySites.filter((site) => site !== normalizedDomain),
  };
}
