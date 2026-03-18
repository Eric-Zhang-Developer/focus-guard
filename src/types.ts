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
