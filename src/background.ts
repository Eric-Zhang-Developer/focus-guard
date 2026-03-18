import {
  addDomainToState,
  applyPendingRemovalsToState,
  buildDynamicRules,
  cancelPendingRemoval,
  getCurrentBlockWindow,
  isInBlockWindow,
  isLikelyDomain,
  normalizeDomain,
  queuePendingRemoval,
  removeDomainFromState,
} from "./background-core";
import { DEFAULT_STORAGE } from "./types";
import type {
  AddSiteMessage,
  CancelRemoveMessage,
  ErrorResponse,
  GetStateResponse,
  QueueRemoveMessage,
  RuntimeMessage,
  RuntimeResponse,
  StorageSchema,
} from "./types";

const APPLY_PENDING_ALARM = "focus-guard-apply-pending";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeStorage(rawStorage: Partial<StorageSchema>): StorageSchema {
  const blockedSites = isStringArray(rawStorage.blockedSites)
    ? [...new Set(rawStorage.blockedSites.map(normalizeDomain).filter(isLikelyDomain))]
    : [...DEFAULT_STORAGE.blockedSites];

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

  return {
    blockedSites,
    pendingRemovals,
  };
}

async function readStorage(): Promise<StorageSchema> {
  const rawStorage = await chrome.storage.sync.get(["blockedSites", "pendingRemovals"]);

  return normalizeStorage(rawStorage);
}

async function writeStorage(storage: StorageSchema): Promise<void> {
  await chrome.storage.sync.set(storage);
}

async function ensureStorageDefaults(): Promise<void> {
  const existing = await chrome.storage.sync.get(["blockedSites", "pendingRemovals"]);
  const updates: Partial<StorageSchema> = {};

  if (!Array.isArray(existing.blockedSites)) {
    updates.blockedSites = DEFAULT_STORAGE.blockedSites;
  }

  if (!Array.isArray(existing.pendingRemovals)) {
    updates.pendingRemovals = DEFAULT_STORAGE.pendingRemovals;
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
  const domains = blockedSites ?? (await readStorage()).blockedSites;
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRules.map((rule) => rule.id),
    addRules: buildDynamicRules(domains),
  });
}

function blockedSitesChanged(previous: StorageSchema, next: StorageSchema): boolean {
  return JSON.stringify(previous.blockedSites) !== JSON.stringify(next.blockedSites);
}

async function reconcilePendingRemovals(): Promise<StorageSchema> {
  const storage = await readStorage();
  const nextStorage = applyPendingRemovalsToState(storage);

  if (nextStorage === storage) {
    return storage;
  }

  await writeStorage(nextStorage);

  if (blockedSitesChanged(storage, nextStorage)) {
    await syncRules(nextStorage.blockedSites);
  }

  return nextStorage;
}

async function bootstrapBackground(): Promise<void> {
  await ensureStorageDefaults();
  await ensureAlarm();
  const storage = await reconcilePendingRemovals();
  await syncRules(storage.blockedSites);
}

function errorResponse(error: string): ErrorResponse {
  return {
    ok: false,
    error,
  };
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
  const storage = await reconcilePendingRemovals();
  const activeWindow = getCurrentBlockWindow();

  return {
    sites: storage.blockedSites,
    pendingRemovals: storage.pendingRemovals,
    isBlocking: activeWindow !== null,
    activeWindow,
  };
}

async function handleAddSite(message: AddSiteMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePendingRemovals();
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
  const storage = await reconcilePendingRemovals();
  const domain = normalizeDomain(message.domain);

  if (!isLikelyDomain(domain)) {
    return errorResponse("Invalid domain.");
  }

  if (!storage.blockedSites.includes(domain)) {
    return errorResponse("Domain is not currently blocked.");
  }

  if (!isInBlockWindow()) {
    const nextStorage = removeDomainFromState(storage, domain);

    if (nextStorage !== storage) {
      await writeStorage(nextStorage);
      await syncRules(nextStorage.blockedSites);
    }

    return {
      ok: true,
      appliedImmediately: true,
      applyAt: null,
    };
  }

  const reason = message.reason.trim();

  if (!reason) {
    return errorResponse("A reason is required during an active block window.");
  }

  const queued = queuePendingRemoval(storage, domain, reason);

  if (queued.storage !== storage) {
    await writeStorage(queued.storage);
  }

  return {
    ok: true,
    appliedImmediately: false,
    applyAt: queued.applyAt,
  };
}

async function handleCancelRemove(message: CancelRemoveMessage): Promise<RuntimeResponse> {
  const storage = await reconcilePendingRemovals();
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

  void reconcilePendingRemovals();
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
