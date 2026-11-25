import { DEFAULT_BLOCK_WINDOWS, DEFAULT_FRICTION_DELAY_MS } from "./config";

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BlockWindow {
  label: string;
  days: DayOfWeek[];
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

export interface PendingRemoval {
  domain: string;
  reason: string;
  scheduledAt: number;
  applyAt: number;
  // Set for a pass: the site opens at applyAt and is blocked again at reblockAt.
  // Absent for a permanent removal, which takes the site off the list at applyAt.
  reblockAt?: number;
}

export interface PendingSettingsChange {
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  reason: string;
  scheduledAt: number;
  applyAt: number;
}

export interface FocusSession {
  endsAt: number;
  // Set while an early end is waiting: endsAt has been pulled in to when the wait is over,
  // and cancelling puts originalEndsAt back.
  endingEarly?: { reason: string; originalEndsAt: number };
}

export interface StorageSchema {
  blockedSites: string[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingRemovals: PendingRemoval[];
  pendingSettingsChange: PendingSettingsChange | null;
  // Sites blocked only during a focus session, not in scheduled windows. A subset of blockedSites.
  focusOnlySites: string[];
  focusSession: FocusSession | null;
  // Addresses left open inside a blocked site. Each is a strict subdomain of a blocked site.
  allowedSites: string[];
}

export const DEFAULT_STORAGE: StorageSchema = {
  blockedSites: [],
  blockWindows: DEFAULT_BLOCK_WINDOWS,
  frictionDelayMs: DEFAULT_FRICTION_DELAY_MS,
  pendingRemovals: [],
  pendingSettingsChange: null,
  focusOnlySites: [],
  focusSession: null,
  allowedSites: [],
};

export interface GetStateMessage {
  type: "GET_STATE";
}

export interface AddSiteMessage {
  type: "ADD_SITE";
  domain: string;
}

export interface QueueRemoveMessage {
  type: "QUEUE_REMOVE";
  domain: string;
  reason: string;
  // Pass length. Omit to remove the site for good.
  minutes?: number;
}

export interface CancelRemoveMessage {
  type: "CANCEL_REMOVE";
  domain: string;
}

export interface UpdateSettingsMessage {
  type: "UPDATE_SETTINGS";
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  reason?: string;
}

export interface CancelSettingsMessage {
  type: "CANCEL_SETTINGS";
}

export interface StartFocusMessage {
  type: "START_FOCUS";
  minutes: number;
}

export interface EndFocusMessage {
  type: "END_FOCUS";
  reason: string;
}

export interface CancelEndFocusMessage {
  type: "CANCEL_END_FOCUS";
}

export interface SetFocusOnlyMessage {
  type: "SET_FOCUS_ONLY";
  domain: string;
  focusOnly: boolean;
}

export interface AllowSiteMessage {
  type: "ALLOW_SITE";
  domain: string;
}

export interface RemoveAllowedMessage {
  type: "REMOVE_ALLOWED";
  domain: string;
}

export type RuntimeMessage =
  | GetStateMessage
  | AddSiteMessage
  | QueueRemoveMessage
  | CancelRemoveMessage
  | UpdateSettingsMessage
  | CancelSettingsMessage
  | StartFocusMessage
  | EndFocusMessage
  | CancelEndFocusMessage
  | SetFocusOnlyMessage
  | AllowSiteMessage
  | RemoveAllowedMessage;

export interface GetStateResponse {
  sites: string[];
  allowedSites: string[];
  pendingRemovals: PendingRemoval[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingSettingsChange: PendingSettingsChange | null;
  focusOnlySites: string[];
  // Null unless a session is running right now.
  focusSession: FocusSession | null;
  // True in a scheduled window or a focus session.
  isBlocking: boolean;
  activeWindow: BlockWindow | null;
}

export interface SuccessResponse {
  ok: true;
}

export interface QueueRemoveResponse extends SuccessResponse {
  appliedImmediately: boolean;
  applyAt: number | null;
}

export interface UpdateSettingsResponse extends SuccessResponse {
  appliedImmediately: boolean;
  applyAt: number | null;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type RuntimeResponse =
  | GetStateResponse
  | SuccessResponse
  | QueueRemoveResponse
  | UpdateSettingsResponse
  | ErrorResponse;
