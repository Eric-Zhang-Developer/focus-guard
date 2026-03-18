import { getCurrentBlockWindow } from "./background-core";
import type { StorageSchema } from "./types";

const params = new URLSearchParams(window.location.search);
const domain = params.get("domain") ?? null;

function formatEndTime(hour: number, min: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = min.toString().padStart(2, "0");
  const ampm = hour < 12 ? "am" : "pm";
  return `${h}:${m} ${ampm}`;
}

function render(storage: StorageSchema): void {
  const domainEl = document.getElementById("domain");
  const windowInfoEl = document.getElementById("window-info");
  const windowLabelEl = document.getElementById("window-label");
  const windowEndEl = document.getElementById("window-end");

  if (domainEl) {
    domainEl.textContent = domain ?? "This site";
  }

  const activeWindow = getCurrentBlockWindow();

  if (activeWindow && windowInfoEl && windowLabelEl && windowEndEl) {
    windowLabelEl.textContent = activeWindow.label;
    windowEndEl.textContent = `ends at ${formatEndTime(activeWindow.endHour, activeWindow.endMin)}`;
    windowInfoEl.classList.remove("hidden");
  }
}

chrome.storage.sync.get(
  ["blockedSites", "pendingRemovals"],
  (items) => {
    const storage: StorageSchema = {
      blockedSites: (items["blockedSites"] as string[]) ?? [],
      pendingRemovals: (items["pendingRemovals"] as StorageSchema["pendingRemovals"]) ?? [],
    };
    render(storage);
  },
);
