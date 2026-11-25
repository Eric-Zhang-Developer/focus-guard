// Helpers shared by the popup and the settings page.
import type { RuntimeMessage, RuntimeResponse } from "./types";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function fmtTime(hour: number, min: number): string {
  return `${pad(hour)}:${pad(min)}`;
}

export function fmtCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${pad(s)}s`;
}

export async function sendMessage(msg: RuntimeMessage): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(msg) as Promise<RuntimeResponse>;
}

const countdownTimers: number[] = [];

export function clearCountdowns(): void {
  for (const id of countdownTimers) clearInterval(id);
  countdownTimers.length = 0;
}

// Ticks a countdown, then calls onDone once it runs out: asking the background for state is
// what applies a due change, so the page moves on instead of sitting at 0m 00s.
export function startCountdown(el: HTMLElement, until: number, onDone: () => void): void {
  const render = (): void => {
    el.textContent = fmtCountdown(until - Date.now());
  };
  render();

  const id = setInterval(() => {
    render();
    if (until <= Date.now()) onDone();
  }, 1000) as unknown as number;
  countdownTimers.push(id);
}
