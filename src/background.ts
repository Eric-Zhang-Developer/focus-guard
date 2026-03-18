import {
  addDomainToState,
  getActiveBlockedSites,
  applyPendingRemovalsToState,
  applyPendingSettingsToState,
  buildDynamicRules,
  cancelPendingRemoval,
  cancelSettingsChange,
  getCurrentBlockWindow,
  isInBlockWindow,
  isLikelyDomain,
  isWeakeningSettingsChange,
  normalizeDomain,
  queuePendingRemoval,
  queueSettingsChange,
  removeDomainFromState,
} from "./background-core";
import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";
import { DEFAULT_STORAGE } from "./types";
import type {
  AddSiteMessage,
  BlockWindow,
  CancelRemoveMessage,
  CancelSettingsMessage,
  ErrorResponse,
  GetStateResponse,
  QueueRemoveMessage,
  RuntimeMessage,
  RuntimeResponse,
  StorageSchema,
  UpdateSettingsMessage,
  UpdateSettingsResponse,
} from "./types";

const APPLY_PENDING_ALARM = "focus-guard-apply-pending";

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

  return {
    blockedSites,
    blockWindows,
    frictionDelayMs,
    pendingRemovals,
    pendingSettingsChange,
  };
}

async function readStorage(): Promise<StorageSchema> {
  const rawStorage = await chrome.storage.sync.get([
    "blockedSites",
    "blockWindows",
    "frictionDelayMs",
    "pendingRemovals",
    "pendingSettingsChange",
  ]);

  return normalizeStorage(rawStorage);
}

async function writeStorage(storage: StorageSchema): Promise<void> {
  await chrome.storage.sync.set(storage);
}

async function ensureStorageDefaults(): Promise<void> {
  const existing = await chrome.storage.sync.get([
    "blockedSites",
    "blockWindows",
    "frictionDelayMs",
    "pendingRemovals",
    "pendingSettingsChange",
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

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

async function ensureAlarm(): Promise<void> {
  await chrome.alarms.create(APPLY_PENDING_ALARM, {
    periodInMinutes: 1,
  });
}

async function syncRules(blockedSites?: string[]): Promise<void> {
  const storage = await readStorage();
  const domains = getActiveBlockedSites(
    blockedSites ?? storage.blockedSites,
    storage.blockWindows,
    new Date(),
  );
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: buildDynamicRules(domains),
  });
}

async function reconcilePending(): Promise<StorageSchema> {
  const storage = await readStorage();
  const afterRemovals = applyPendingRemovalsToState(storage);
  const afterSettings = applyPendingSettingsToState(afterRemovals);

  if (afterSettings === storage) {
    await syncRules(storage.blockedSites);
    return storage;
  }

  await writeStorage(afterSettings);
  await syncRules(afterSettings.blockedSites);

  return afterSettings;
}

async function bootstrapBackground(): Promise<void> {
  await ensureStorageDefaults();
  await ensureAlarm();
  await reconcilePending();
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
    pendingRemovals: storage.pendingRemovals,
    blockWindows: storage.blockWindows,
    frictionDelayMs: storage.frictionDelayMs,
    pendingSettingsChange: storage.pendingSettingsChange,
    isBlocking: activeWindow !== null,
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
    await syncRules(nextStorage.blockedSites);
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

  if (!isInBlockWindow(new Date(), storage.blockWindows)) {
    const nextStorage = removeDomainFromState(storage, domain);

    if (nextStorage !== storage) {
      await writeStorage(nextStorage);
      await syncRules(nextStorage.blockedSites);
    }

    return { ok: true, appliedImmediately: true, applyAt: null };
  }

  const reason = message.reason.trim();

  if (!reason) {
    return errorResponse("A reason is required during an active block window.");
  }

  const queued = queuePendingRemoval(storage, domain, reason, Date.now(), storage.frictionDelayMs);

  if (queued.storage !== storage) {
    await writeStorage(queued.storage);
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
  const inBlock = isInBlockWindow(new Date(), storage.blockWindows);

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
    return { ok: true, appliedImmediately: false, applyAt: queued.applyAt };
  }

  const nextStorage: StorageSchema = {
    ...storage,
    blockWindows: message.blockWindows,
    frictionDelayMs: message.frictionDelayMs,
  };

  await writeStorage(nextStorage);
  await syncRules(nextStorage.blockedSites);
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
    default:
      return errorResponse("Unsupported message type.");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapBackground();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapBackground();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== APPLY_PENDING_ALARM) {
    return;
  }

  void reconcilePending();
});

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
