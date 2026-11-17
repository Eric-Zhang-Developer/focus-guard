import { getCurrentBlockWindow } from "./background-core";
import type { BlockWindow } from "./types";

const domain = new URLSearchParams(window.location.search).get("domain");

if (domain) {
  document.getElementById("domain")!.textContent = domain;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

chrome.storage.sync.get(["blockWindows"], (items) => {
  const blockWindows: BlockWindow[] = Array.isArray(items.blockWindows) ? items.blockWindows : [];
  const active = getCurrentBlockWindow(new Date(), blockWindows);

  if (!active) return;

  document.getElementById("window-label")!.textContent = active.label;
  document.getElementById("window-end")!.textContent =
    `ends at ${pad(active.endHour)}:${pad(active.endMin)}`;
  document.getElementById("window-info")!.classList.add("visible");
});
