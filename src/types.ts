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

export interface StorageSchema {
  blockedSites: string[];
  pendingRemovals: PendingRemoval[];
}

export const DEFAULT_STORAGE: StorageSchema = {
  blockedSites: [],
  pendingRemovals: [],
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

export type RuntimeMessage =
  | GetStateMessage
  | AddSiteMessage
  | QueueRemoveMessage
  | CancelRemoveMessage;

export interface GetStateResponse {
  sites: string[];
  pendingRemovals: PendingRemoval[];
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

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type RuntimeResponse =
  | GetStateResponse
  | SuccessResponse
  | QueueRemoveResponse
  | ErrorResponse;
