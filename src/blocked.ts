import { getCurrentBlockWindow, isFocusSessionActive } from "./background-core";
import type { BlockWindow, FocusSession } from "./types";

const domain = new URLSearchParams(window.location.search).get("domain");

if (domain) {
  document.getElementById("domain")!.textContent = domain;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

chrome.storage.sync.get(["blockWindows", "focusSession"], (items) => {
  const blockWindows: BlockWindow[] = Array.isArray(items.blockWindows) ? items.blockWindows : [];
  const focusSession: FocusSession | null =
    typeof items.focusSession?.endsAt === "number" ? items.focusSession : null;
  const sessionEnd =
    focusSession && isFocusSessionActive({ focusSession }) ? new Date(focusSession.endsAt) : null;
  // A session blocks more than a window does, so it is the one to name.
  const active = sessionEnd
    ? { label: "Focus session", endHour: sessionEnd.getHours(), endMin: sessionEnd.getMinutes() }
    : getCurrentBlockWindow(new Date(), blockWindows);

  if (!active) return;

  document.getElementById("window-label")!.textContent = active.label;
  document.getElementById("window-end")!.textContent =
    `ends at ${pad(active.endHour)}:${pad(active.endMin)}`;
  document.getElementById("window-info")!.classList.add("visible");
});
