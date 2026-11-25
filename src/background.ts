import {
  addDomainToState,
  getActiveBlockedSites,
  applyPendingRemovalsToState,
  applyPendingSettingsToState,
  buildDynamicRules,
  canAllow,
  cancelFocusSessionEnd,
  cancelPendingRemoval,
  cancelSettingsChange,
  clearEndedFocusSession,
  getBlockedDomainForUrl,
  getCurrentBlockWindow,
  getNextPendingChangeAt,
  isBlockingNow,
  isFocusSessionActive,
  isLikelyDomain,
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
import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";
import { DEFAULT_STORAGE } from "./types";
import type {
  AddSiteMessage,
  AllowSiteMessage,
  BlockWindow,
  CancelRemoveMessage,
  CancelSettingsMessage,
  EndFocusMessage,
  ErrorResponse,
  FocusSession,
  GetStateResponse,
  QueueRemoveMessage,
  RemoveAllowedMessage,
  RuntimeMessage,
  RuntimeResponse,
  SetFocusOnlyMessage,
  StartFocusMessage,
  StorageSchema,
  UpdateSettingsMessage,
  UpdateSettingsResponse,
} from "./types";

const APPLY_PENDING_ALARM = "focus-guard-apply-pending";
const NEXT_CHANGE_ALARM = "focus-guard-next-change";
const BLOCKED_PAGE_PATH = "/blocked.html";
const LAST_KNOWN_BLOCKING_STATE_KEY = "lastKnownBlockingState";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidBlockWindow(value: unknown): value is BlockWindow {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.label === "string" &&
    Array.isArray(w.days) &&
    (w.days as unknown[]).every((d) => typeof d === "number") &&
    typeof w.startHour === "number" &&
    typeof w.startMin === "number" &&
    typeof w.endHour === "number" &&
    typeof w.endMin === "number"
  );
}

function isValidFocusSession(value: unknown): value is FocusSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.endsAt !== "number") return false;
  if (s.endingEarly === undefined) return true;
  const e = s.endingEarly as Record<string, unknown> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.reason === "string" &&
    typeof e.originalEndsAt === "number"
  );
}

function normalizeStorage(rawStorage: Partial<StorageSchema>): StorageSchema {
  const blockedSites = isStringArray(rawStorage.blockedSites)
    ? [...new Set(rawStorage.blockedSites.map(normalizeDomain).filter(isLikelyDomain))]
    : [...DEFAULT_STORAGE.blockedSites];

  const blockWindows =
    Array.isArray(rawStorage.blockWindows) && rawStorage.blockWindows.every(isValidBlockWindow)
      ? rawStorage.blockWindows
      : [...DEFAULT_BLOCK_WINDOWS];

  const frictionDelayMs =
    typeof rawStorage.frictionDelayMs === "number" && rawStorage.frictionDelayMs > 0
      ? rawStorage.frictionDelayMs
      : DEFAULT_FRICTION_DELAY_MS;

  const pendingRemovals = Array.isArray(rawStorage.pendingRemovals)
    ? rawStorage.pendingRemovals.reduce<StorageSchema["pendingRemovals"]>((pending, entry) => {
        if (
          typeof entry?.domain !== "string" ||
          typeof entry.reason !== "string" ||
          typeof entry.scheduledAt !== "number" ||
          typeof entry.applyAt !== "number"
        ) {
          return pending;
        }

        const domain = normalizeDomain(entry.domain);

        if (!isLikelyDomain(domain) || pending.some((item) => item.domain === domain)) {
          return pending;
        }

        pending.push({
          domain,
          reason: entry.reason.trim(),
          scheduledAt: entry.scheduledAt,
          applyAt: entry.applyAt,
          ...(typeof entry.reblockAt === "number" && entry.reblockAt > entry.applyAt
            ? { reblockAt: entry.reblockAt }
            : {}),
        });

        return pending;
      }, [])
    : [...DEFAULT_STORAGE.pendingRemovals];

  const rawPending = rawStorage.pendingSettingsChange as unknown;
  const pendingSettingsChange =
    rawPending !== null &&
    typeof rawPending === "object" &&
    Array.isArray((rawPending as Record<string, unknown>)["blockWindows"]) &&
    typeof (rawPending as Record<string, unknown>)["frictionDelayMs"] === "number" &&
    typeof (rawPending as Record<string, unknown>)["reason"] === "string" &&
    typeof (rawPending as Record<string, unknown>)["scheduledAt"] === "number" &&
    typeof (rawPending as Record<string, unknown>)["applyAt"] === "number"
      ? (rawPending as StorageSchema["pendingSettingsChange"])
      : null;

  const focusOnlySites = isStringArray(rawStorage.focusOnlySites)
    ? [...new Set(rawStorage.focusOnlySites.map(normalizeDomain))].filter((site) =>
        blockedSites.includes(site),
      )
    : [...DEFAULT_STORAGE.focusOnlySites];

  const focusSession = isValidFocusSession(rawStorage.focusSession) ? rawStorage.focusSession : null;

  const allowedSites = isStringArray(rawStorage.allowedSites)
    ? [...new Set(rawStorage.allowedSites.map(normalizeDomain).filter(isLikelyDomain))].filter(
        (site) => canAllow(site, blockedSites),
      )
    : [...DEFAULT_STORAGE.allowedSites];

  return {
    blockedSites,
    blockWindows,
    frictionDelayMs,
    pendingRemovals,
    pendingSettingsChange,
    focusOnlySites,
    focusSession,
    allowedSites,
  };
}

async function readStorage(): Promise<StorageSchema> {
  const rawStorage = await chrome.storage.sync.get([
    "blockedSites",
    "blockWindows",
    "frictionDelayMs",
    "pendingRemovals",
    "pendingSettingsChange",
    "focusOnlySites",
    "focusSession",
    "allowedSites",
  ]);

  return normalizeStorage(rawStorage);
}

async function writeStorage(storage: StorageSchema): Promise<void> {
  await chrome.storage.sync.set(storage);
}

async function readLastKnownBlockingState(): Promise<boolean | null> {
  const runtimeState = await chrome.storage.local.get(LAST_KNOWN_BLOCKING_STATE_KEY);
  const value = runtimeState[LAST_KNOWN_BLOCKING_STATE_KEY];

  return typeof value === "boolean" ? value : null;
}

async function writeLastKnownBlockingState(isBlocking: boolean): Promise<void> {
  await chrome.storage.local.set({
    [LAST_KNOWN_BLOCKING_STATE_KEY]: isBlocking,
  });
}

async function ensureStorageDefaults(): Promise<void> {
  const existing = await chrome.storage.sync.get([
    "blockedSites",
    "blockWindows",
    "frictionDelayMs",
    "pendingRemovals",
    "pendingSettingsChange",
    "focusOnlySites",
    "focusSession",
    "allowedSites",
  ]);
  const updates: Partial<StorageSchema> = {};

  if (!Array.isArray(existing.blockedSites)) {
    updates.blockedSites = DEFAULT_STORAGE.blockedSites;
  }

  if (!Array.isArray(existing.blockWindows)) {
    updates.blockWindows = DEFAULT_STORAGE.blockWindows;
  }

  if (typeof existing.frictionDelayMs !== "number") {
    updates.frictionDelayMs = DEFAULT_STORAGE.frictionDelayMs;
  }

  if (!Array.isArray(existing.pendingRemovals)) {
    updates.pendingRemovals = DEFAULT_STORAGE.pendingRemovals;
  }

  if (!("pendingSettingsChange" in existing)) {
    updates.pendingSettingsChange = DEFAULT_STORAGE.pendingSettingsChange;
  }

  if (!Array.isArray(existing.focusOnlySites)) {
    updates.focusOnlySites = DEFAULT_STORAGE.focusOnlySites;
  }

  if (!("focusSession" in existing)) {
    updates.focusSession = DEFAULT_STORAGE.focusSession;
  }

  if (!Array.isArray(existing.allowedSites)) {
    updates.allowedSites = DEFAULT_STORAGE.allowedSites;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

async function ensureAlarm(): Promise<void> {
  await chrome.alarms.create(APPLY_PENDING_ALARM, {
    periodInMinutes: 1,
  });
}

let ruleSync: Promise<void> = Promise.resolve();

// One update at a time: two overlapping updates both read "no rules installed", both add
// rule id 1, and Chrome rejects the second. Never rejects: a failed update is retried on
// the next alarm tick and must not fail the popup request that happened to trigger it.
function syncRules(): Promise<void> {
  ruleSync = ruleSync.then(applyRules).catch((error: unknown) => {
    console.error("Focus Guard rule sync failed", error);
  });

  return ruleSync;
}

// Reads storage when it runs, not when it was queued, so the last sync always wins.
async function applyRules(): Promise<void> {
  const storage = await readStorage();
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: buildDynamicRules(getActiveBlockedSites(storage), storage.allowedSites),
  });
}

// One-shot wake-up for the next queued change, so a pass starts and ends on time and not
// on the next once-a-minute tick.
async function scheduleNextChange(storage: StorageSchema): Promise<void> {
  const when = getNextPendingChangeAt(storage);

  if (when === null) {
    await chrome.alarms.clear(NEXT_CHANGE_ALARM);
    return;
  }

  await chrome.alarms.create(NEXT_CHANGE_ALARM, { when });
}

// Everything that has to follow a change to what is blocked.
async function applyBlockingChange(storage: StorageSchema): Promise<void> {
  await syncRules();
  await scheduleNextChange(storage);
  // Rules only catch new navigations. Storage is already written, so a tab that cannot be
  // redirected must not turn the request into an error.
  await enforceOpenTabs(storage).catch((error: unknown) => {
    console.warn("Focus Guard open-tab enforcement skipped", error);
  });
}

function getBlockedPageUrl(domain: string): string {
  return chrome.runtime.getURL(`${BLOCKED_PAGE_PATH}?domain=${encodeURIComponent(domain)}`);
}

async function redirectTabToBlockedPage(tabId: number, domain: string): Promise<void> {
  await chrome.tabs.update(tabId, {
    url: getBlockedPageUrl(domain),
  });
}

async function enforceTabIfNeeded(
  tab: chrome.tabs.Tab,
  storage?: StorageSchema,
): Promise<boolean> {
  const tabId = tab.id;
  const tabUrl = tab.pendingUrl ?? tab.url;

  if (typeof tabId !== "number" || typeof tabUrl !== "string") {
    return false;
  }

  const currentStorage = storage ?? (await reconcilePending());

  const matchedDomain = getBlockedDomainForUrl(
    tabUrl,
    getActiveBlockedSites(currentStorage),
    currentStorage.allowedSites,
  );

  if (matchedDomain === null) {
    return false;
  }

  await redirectTabToBlockedPage(tabId, matchedDomain);
  return true;
}

async function enforceOpenTabs(storage?: StorageSchema): Promise<number> {
  const currentStorage = storage ?? (await reconcilePending());

  if (!isBlockingNow(currentStorage)) {
    return 0;
  }

  const tabs = await chrome.tabs.query({});
  let redirectedCount = 0;

  for (const tab of tabs) {
    if (await enforceTabIfNeeded(tab, currentStorage)) {
      redirectedCount += 1;
    }
  }

  return redirectedCount;
}

async function syncBlockingState(storage?: StorageSchema): Promise<StorageSchema> {
  const currentStorage = storage ?? (await reconcilePending());
  const isBlocking = isBlockingNow(currentStorage);
  const wasBlocking = await readLastKnownBlockingState();

  if (isBlocking && wasBlocking !== true) {
    await enforceOpenTabs(currentStorage);
  }

  if (wasBlocking !== isBlocking) {
    await writeLastKnownBlockingState(isBlocking);
  }

  return currentStorage;
}

async function reconcilePending(): Promise<StorageSchema> {
  const storage = await readStorage();
  const next = clearEndedFocusSession(
    applyPendingSettingsToState(applyPendingRemovalsToState(storage)),
  );

  if (next === storage) {
    // Still synced: a pass opening changes what is blocked without changing storage.
    await syncRules();
    await scheduleNextChange(storage);
    return storage;
  }

  await writeStorage(next);
  // A pass that just ended can leave a tab sitting on a site that is blocked again.
  await applyBlockingChange(next);

  return next;
}

async function bootstrapBackground(): Promise<void> {
  await ensureStorageDefaults();
  await ensureAlarm();
  const storage = await reconcilePending();
  await syncBlockingState(storage);
}

function errorResponse(error: string): ErrorResponse {
  return { ok: false, error };
}

function isRuntimeMessage(message: unknown): message is RuntimeMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    typeof message.type === "string"
  );
}

async function handleGetState(): Promise<GetStateResponse> {
  const storage = await reconcilePending();
  const activeWindow = getCurrentBlockWindow(new Date(), storage.blockWindows);

  return {
    sites: storage.blockedSites,
    allowedSites: storage.allowedSites,
    pendingRemovals: storage.pendingRemovals,
    blockWindows: storage.blockWindows,
    frictionDelayMs: storage.frictionDelayMs,
    pendingSettingsChange: storage.pendingSettingsChange,
    focusOnlySites: storage.focusOnlySites,
    focusSession: isFocusSessionActive(storage) ? storage.focusSession : null,
    isBlocking: isBlockingNow(storage),
    activeWindow,
  };
}

async function handleAddSite(message: AddSiteMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);

  if (!isLikelyDomain(domain)) {
    return errorResponse("Invalid domain.");
  }

  const nextStorage = addDomainToState(storage, domain);

  if (nextStorage !== storage) {
    await writeStorage(nextStorage);
    await applyBlockingChange(nextStorage);
  }

  return { ok: true };
}

async function handleQueueRemove(message: QueueRemoveMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);

  if (!isLikelyDomain(domain)) {
    return errorResponse("Invalid domain.");
  }

  if (!storage.blockedSites.includes(domain)) {
    return errorResponse("Domain is not currently blocked.");
  }

  if (!isSiteEnforced(storage, domain)) {
    const nextStorage = removeDomainFromState(storage, domain);

    if (nextStorage !== storage) {
      await writeStorage(nextStorage);
      await syncRules();
    }

    return { ok: true, appliedImmediately: true, applyAt: null };
  }

  const reason = message.reason.trim();

  if (!reason) {
    return errorResponse("A reason is required during an active block window.");
  }

  const { minutes } = message;

  if (minutes !== undefined && !(Number.isFinite(minutes) && minutes > 0)) {
    return errorResponse("Enter a number of minutes, or leave it empty to remove the site.");
  }

  const queued = queuePendingRemoval(
    storage,
    domain,
    reason,
    Date.now(),
    storage.frictionDelayMs,
    minutes,
  );

  if (queued.storage !== storage) {
    await writeStorage(queued.storage);
    await scheduleNextChange(queued.storage);
  }

  return { ok: true, appliedImmediately: false, applyAt: queued.applyAt };
}

async function handleCancelRemove(message: CancelRemoveMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);

  if (!isLikelyDomain(domain)) {
    return errorResponse("Invalid domain.");
  }

  const nextStorage = cancelPendingRemoval(storage, domain);

  if (nextStorage !== storage) {
    await writeStorage(nextStorage);
    // Cancelling an open pass ends it, so the site has to be blocked again right away.
    await applyBlockingChange(nextStorage);
  }

  return { ok: true };
}

async function handleUpdateSettings(
  message: UpdateSettingsMessage,
): Promise<UpdateSettingsResponse | ErrorResponse> {
  const storage = await reconcilePending();

  if (storage.pendingSettingsChange !== null) {
    return errorResponse("A settings change is already queued. Cancel it first.");
  }

  const proposed = {
    blockWindows: message.blockWindows,
    frictionDelayMs: message.frictionDelayMs,
  };

  const weakening = isWeakeningSettingsChange(storage, proposed);
  const inBlock = isBlockingNow(storage);

  if (weakening && inBlock) {
    const reason = (message.reason ?? "").trim();

    if (!reason) {
      return errorResponse("A reason is required to weaken settings during a block window.");
    }

    const queued = queueSettingsChange(
      storage,
      message.blockWindows,
      message.frictionDelayMs,
      reason,
    );
    await writeStorage(queued.storage);
    await scheduleNextChange(queued.storage);
    return { ok: true, appliedImmediately: false, applyAt: queued.applyAt };
  }

  const nextStorage: StorageSchema = {
    ...storage,
    blockWindows: message.blockWindows,
    frictionDelayMs: message.frictionDelayMs,
  };

  await writeStorage(nextStorage);
  await syncRules();
  return { ok: true, appliedImmediately: true, applyAt: null };
}

async function handleCancelSettings(_message: CancelSettingsMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const nextStorage = cancelSettingsChange(storage);

  if (nextStorage !== storage) {
    await writeStorage(nextStorage);
  }

  return { ok: true };
}

async function handleStartFocus(message: StartFocusMessage): Promise<RuntimeResponse> {
  if (!(Number.isFinite(message.minutes) && message.minutes > 0)) {
    return errorResponse("Enter a number of minutes.");
  }

  const nextStorage = startFocusSession(await reconcilePending(), message.minutes);

  await writeStorage(nextStorage);
  await applyBlockingChange(nextStorage);
  return { ok: true };
}

async function handleEndFocus(message: EndFocusMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const reason = message.reason.trim();

  if (!reason) {
    return errorResponse("A reason is required to end a focus session early.");
  }

  if (!isFocusSessionActive(storage)) {
    return errorResponse("No focus session is running.");
  }

  const nextStorage = requestFocusSessionEnd(storage, reason);

  if (nextStorage === storage) {
    return errorResponse("The session ends before the wait would. Let it run out.");
  }

  await writeStorage(nextStorage);
  await scheduleNextChange(nextStorage);
  return { ok: true };
}

async function handleCancelEndFocus(): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const nextStorage = cancelFocusSessionEnd(storage);

  if (nextStorage !== storage) {
    await writeStorage(nextStorage);
    await scheduleNextChange(nextStorage);
  }

  return { ok: true };
}

async function handleSetFocusOnly(message: SetFocusOnlyMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);

  if (!storage.blockedSites.includes(domain)) {
    return errorResponse("Domain is not currently blocked.");
  }

  // Loosening, so not while anything is blocked. Deliberately not queued: wait it out, or
  // remove the site the usual way.
  if (message.focusOnly && isBlockingNow(storage)) {
    return errorResponse("A site can only be made focus only while nothing is blocked.");
  }

  const nextStorage = setFocusOnly(storage, domain, message.focusOnly);

  if (nextStorage !== storage) {
    await writeStorage(nextStorage);
    // Making a site "always" can block it right now, so follow it like adding a site.
    await applyBlockingChange(nextStorage);
  }

  return { ok: true };
}

async function handleAllowSite(message: AllowSiteMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);

  if (!isLikelyDomain(domain)) {
    return errorResponse("Invalid domain.");
  }

  // Loosening, so not while anything is blocked. Deliberately not queued, like focus only.
  if (isBlockingNow(storage)) {
    return errorResponse("An address can only be allowed while nothing is blocked.");
  }

  if (storage.blockedSites.includes(domain)) {
    return errorResponse(`${domain} is on the block list. Remove it there instead.`);
  }

  if (!canAllow(domain, storage.blockedSites)) {
    return errorResponse(
      "Only an address inside a blocked site can be allowed, like music.youtube.com inside youtube.com.",
    );
  }

  if (!storage.allowedSites.includes(domain)) {
    await writeStorage({ ...storage, allowedSites: [...storage.allowedSites, domain] });
    await syncRules();
  }

  return { ok: true };
}

async function handleRemoveAllowed(message: RemoveAllowedMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePending();
  const domain = normalizeDomain(message.domain);
  const allowedSites = storage.allowedSites.filter((site) => site !== domain);

  if (allowedSites.length !== storage.allowedSites.length) {
    const nextStorage = { ...storage, allowedSites };

    await writeStorage(nextStorage);
    // During a block, a tab open on that address is redirected at once.
    await applyBlockingChange(nextStorage);
  }

  return { ok: true };
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  switch (message.type) {
    case "GET_STATE":
      return handleGetState();
    case "ADD_SITE":
      return handleAddSite(message);
    case "QUEUE_REMOVE":
      return handleQueueRemove(message);
    case "CANCEL_REMOVE":
      return handleCancelRemove(message);
    case "UPDATE_SETTINGS":
      return handleUpdateSettings(message);
    case "CANCEL_SETTINGS":
      return handleCancelSettings(message);
    case "START_FOCUS":
      return handleStartFocus(message);
    case "END_FOCUS":
      return handleEndFocus(message);
    case "CANCEL_END_FOCUS":
      return handleCancelEndFocus();
    case "SET_FOCUS_ONLY":
      return handleSetFocusOnly(message);
    case "ALLOW_SITE":
      return handleAllowSite(message);
    case "REMOVE_ALLOWED":
      return handleRemoveAllowed(message);
    default:
      return errorResponse("Unsupported message type.");
  }
}

function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
  void chrome.tabs
    .get(activeInfo.tabId)
    .then((tab) => enforceTabIfNeeded(tab))
    .catch((error: unknown) => {
      console.warn("Focus Guard tab activation enforcement skipped", error);
    });
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapBackground();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapBackground();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== APPLY_PENDING_ALARM && alarm.name !== NEXT_CHANGE_ALARM) {
    return;
  }

  void reconcilePending()
    .then((storage) => syncBlockingState(storage))
    .catch((error: unknown) => {
      console.error("Focus Guard alarm processing failed", error);
    });
});

chrome.tabs.onActivated.addListener(handleTabActivated);

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(message)) {
    sendResponse(errorResponse("Invalid message payload."));
    return false;
  }

  void handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error("Focus Guard background error", error);
      sendResponse(errorResponse("Unexpected background error."));
    });

  return true;
});

void bootstrapBackground();
