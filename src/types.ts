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
}

export interface PendingSettingsChange {
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  reason: string;
  scheduledAt: number;
  applyAt: number;
}

export interface StorageSchema {
  blockedSites: string[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingRemovals: PendingRemoval[];
  pendingSettingsChange: PendingSettingsChange | null;
}

export const DEFAULT_STORAGE: StorageSchema = {
  blockedSites: [],
  blockWindows: DEFAULT_BLOCK_WINDOWS,
  frictionDelayMs: DEFAULT_FRICTION_DELAY_MS,
  pendingRemovals: [],
  pendingSettingsChange: null,
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

export type RuntimeMessage =
  | GetStateMessage
  | AddSiteMessage
  | QueueRemoveMessage
  | CancelRemoveMessage
  | UpdateSettingsMessage
  | CancelSettingsMessage;

export interface GetStateResponse {
  sites: string[];
  pendingRemovals: PendingRemoval[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingSettingsChange: PendingSettingsChange | null;
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
