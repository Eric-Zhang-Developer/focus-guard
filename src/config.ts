import type { BlockWindow } from "./types";

export const DEFAULT_BLOCK_WINDOWS: BlockWindow[] = [
  {
    label: "Deep Work Morning",
    days: [1, 2, 3, 4, 5],
    startHour: 9,
    startMin: 0,
    endHour: 12,
    endMin: 0,
  },
  {
    label: "Afternoon Focus",
    days: [1, 2, 3, 4, 5],
    startHour: 14,
    startMin: 0,
    endHour: 17,
    endMin: 0,
  },
];

export const DEFAULT_FRICTION_DELAY_MS = 10 * 60 * 1000;
