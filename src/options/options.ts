import type { BlockWindow, DayOfWeek, GetStateResponse, RuntimeResponse } from "../types";
import {
  crossesMidnight,
  getNextBlockWindowStart,
  getWeekSegments,
  isPassOpen,
} from "../background-core";
import { clearCountdowns, fmtTime, sendMessage, startCountdown } from "../ui";

// ── helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_ORDER: DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];
const DAY_MINUTES = 24 * 60;

const ROW_CLASS =
  "flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 py-3 pl-5 pr-3 transition-colors hover:bg-row-hover";
const X_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>';

function fmtDays(days: DayOfWeek[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  if (sorted.join() === "0,6") return "Weekends";
  // A run of three or more reads as a range: "Mon–Fri", "Sun–Thu".
  const last = sorted[sorted.length - 1]!;
  if (sorted.length >= 3 && last - sorted[0]! === sorted.length - 1) {
    return `${DAY_NAMES[sorted[0]!]}–${DAY_NAMES[last]}`;
  }
  // Otherwise Monday first, like the week view.
  return sorted
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => DAY_NAMES[d])
    .join(", ");
}

function fmtMinutes(minutes: number): string {
  return fmtTime(Math.floor(minutes / 60), minutes % 60);
}

function mono(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "font-mono";
  span.textContent = text;
  return span;
}

// The background's error text, or null when the request went through.
function errorOf(resp: RuntimeResponse): string | null {
  return "ok" in resp && !resp.ok ? resp.error : null;
}

function showError(el: HTMLElement, message: string | null): void {
  el.textContent = message ?? "";
  el.hidden = message === null;
}

function iconButton(label: string, inertReason: string | null): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.innerHTML = X_ICON;
  btn.setAttribute("aria-label", label);
  if (inertReason !== null) {
    btn.setAttribute("aria-disabled", "true");
    btn.title = inertReason;
  }
  return btn;
}

// ── state ─────────────────────────────────────────────────────────────────────

let state: GetStateResponse | null = null;

// ── header status ─────────────────────────────────────────────────────────────

function renderStatus(s: GetStateResponse): void {
  const now = new Date();
  let label = "Not blocking";
  let detail: string | null = null;
  let time: string | null = null;

  if (s.focusSession) {
    const end = new Date(s.focusSession.endsAt);
    label = "Focus session";
    detail = "ends at";
    time = fmtTime(end.getHours(), end.getMinutes());
  } else if (s.activeWindow) {
    label = s.activeWindow.label;
    detail = "ends at";
    time = fmtTime(s.activeWindow.endHour, s.activeWindow.endMin);
  } else {
    const next = getNextBlockWindowStart(now, s.blockWindows);
    if (next) {
      detail =
        next.at.toDateString() === now.toDateString()
          ? "next at"
          : `next ${DAY_NAMES[next.at.getDay()]}`;
      time = fmtTime(next.at.getHours(), next.at.getMinutes());
    }
  }

  const blocking = s.focusSession !== null || s.activeWindow !== null;
  document.getElementById("status-dot")!.className = blocking
    ? "pulse size-[7px] rounded-full bg-red-500"
    : "size-[7px] rounded-full bg-slate-500";

  const text = document.getElementById("status-text")!;
  text.replaceChildren(label);
  if (detail !== null && time !== null) {
    const sep = document.createElement("span");
    sep.className = "text-slate-600";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "·";
    const when = document.createElement("span");
    const clock = mono(time);
    clock.classList.add("text-slate-200");
    when.append(`${detail} `, clock);
    text.append(sep, when);
  }
}

// ── pending settings ──────────────────────────────────────────────────────────

function renderPendingSettings(s: GetStateResponse): void {
  const pending = s.pendingSettingsChange;
  document.getElementById("pending-settings-banner")!.hidden = pending === null;
  if (pending) {
    startCountdown(document.getElementById("pending-settings-countdown")!, pending.applyAt, () => {
      void reload();
    });
  }

  // The background refuses another settings change until this one applies or is cancelled.
  for (const id of ["windows-card", "delay-card"]) {
    const el = document.getElementById(id)!;
    el.inert = pending !== null;
    el.classList.toggle("opacity-40", pending !== null);
  }
}

function initCancelSettings(): void {
  document.getElementById("cancel-settings-btn")!.addEventListener("click", () => {
    void sendMessage({ type: "CANCEL_SETTINGS" });
  });
}

// ── blocked sites ─────────────────────────────────────────────────────────────

function renderSites(s: GetStateResponse): void {
  document.getElementById("sites-list")!.replaceChildren(...s.sites.map((d) => buildSiteRow(d, s)));
  document.getElementById("sites-empty")!.hidden = s.sites.length > 0;
}

function buildSiteRow(domain: string, s: GetStateResponse): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `${ROW_CLASS} border-b border-line`;
  li.dataset["domain"] = domain;

  const name = document.createElement("span");
  name.className = "min-w-0 break-all font-mono text-sm text-slate-100";
  name.textContent = domain;
  li.appendChild(name);

  // Waits and passes are run from the popup; here they only show up.
  const pending = s.pendingRemovals.find((r) => r.domain === domain);
  if (pending) {
    const open = isPassOpen(pending);
    const status = document.createElement("span");
    status.className = `flex min-h-10 items-center pr-2 text-[13px] ${open ? "text-emerald-400" : "text-amber-400"}`;
    status.textContent = open
      ? "pass open"
      : pending.reblockAt === undefined
        ? "removal pending"
        : "pass pending";
    li.appendChild(status);
    return li;
  }

  const focusOnly = s.focusOnlySites.includes(domain);
  // Same answer as the background's isSiteEnforced.
  const enforced = s.isBlocking && (s.focusSession !== null || !focusOnly);

  const controls = document.createElement("div");
  controls.className = "flex items-center gap-2";

  const group = document.createElement("div");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `When ${domain} is blocked`);
  group.className = "flex rounded-[10px] border border-edge bg-slate-900 p-[3px]";
  group.append(
    segmentButton(domain, "Always", false, focusOnly, null),
    // Focus only loosens a site, which the background refuses while anything is blocked.
    segmentButton(
      domain,
      "Focus only",
      true,
      focusOnly,
      s.isBlocking && !focusOnly ? "Can't switch to focus only while blocking is on." : null,
    ),
  );

  const remove = iconButton(
    `Remove ${domain}`,
    enforced ? "Blocked right now. Request removal from the popup." : null,
  );
  remove.addEventListener("click", async () => {
    if (enforced) return;
    const errEl = document.getElementById("sites-error")!;
    showError(errEl, null);
    showError(errEl, errorOf(await sendMessage({ type: "QUEUE_REMOVE", domain, reason: "" })));
  });

  controls.append(group, remove);
  li.appendChild(controls);
  return li;
}

function segmentButton(
  domain: string,
  label: string,
  value: boolean,
  focusOnly: boolean,
  inertReason: string | null,
): HTMLButtonElement {
  const pressed = value === focusOnly;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.setAttribute("aria-pressed", String(pressed));
  btn.className = `h-[34px] rounded-[7px] px-3.5 text-[13px] ${
    !pressed
      ? "text-slate-400 hover:text-slate-200 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:text-slate-400"
      : value
        ? "bg-ember-hover font-medium text-orange-300"
        : "bg-slate-800 font-medium text-slate-100"
  }`;
  if (inertReason !== null) {
    btn.setAttribute("aria-disabled", "true");
    btn.title = inertReason;
  }

  btn.addEventListener("click", async () => {
    if (pressed || inertReason !== null) return;
    const errEl = document.getElementById("sites-error")!;
    showError(errEl, null);
    showError(errEl, errorOf(await sendMessage({ type: "SET_FOCUS_ONLY", domain, focusOnly: value })));
  });
  return btn;
}

function initAddSite(): void {
  const input = document.getElementById("add-site") as HTMLInputElement;
  const errEl = document.getElementById("sites-error")!;

  const submit = async (): Promise<void> => {
    showError(errEl, null);
    if (input.value.trim() === "") return;

    const error = errorOf(await sendMessage({ type: "ADD_SITE", domain: input.value }));
    showError(errEl, error);
    if (error === null) input.value = "";
  };

  document.getElementById("add-site-btn")!.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
}

// ── schedule ──────────────────────────────────────────────────────────────────

function renderWeek(s: GetStateResponse): void {
  const week = document.getElementById("week")!;
  // Bars grow in on first paint only, not on every later refresh.
  week.classList.toggle("intro", week.childElementCount === 0);

  const segments = getWeekSegments(s.blockWindows);
  const now = new Date();

  const rows = WEEK_ORDER.map((day) => {
    const today = day === now.getDay();
    const row = document.createElement("div");
    row.className = "day flex items-center gap-3.5";
    row.dataset["day"] = String(day);
    if (today) row.dataset["today"] = "";

    const name = document.createElement("span");
    name.className = `w-[34px] text-xs ${today ? "font-semibold text-slate-100" : "text-slate-400"}`;
    name.textContent = DAY_NAMES[day]!;

    const track = document.createElement("div");
    track.className = `relative h-[22px] flex-1 overflow-hidden rounded-md ${today ? "bg-track-today" : "bg-track"}`;

    for (const at of [25, 50, 75]) {
      const tick = document.createElement("div");
      tick.className = `absolute inset-y-0 w-px ${today ? "bg-tick-today" : "bg-tick"}`;
      tick.style.left = `${at}%`;
      track.appendChild(tick);
    }

    for (const seg of segments[day]!) {
      const w = seg.window;
      const bar = document.createElement("div");
      // Square the edge where an overnight window carries on into the next or previous day.
      const corners = !seg.overnight ? "rounded" : seg.start === 0 ? "rounded-r" : "rounded-l";
      bar.className = `bar absolute inset-y-[3px] ${corners} ${seg.overnight ? "bg-ember" : "bg-orange-400"}`;
      bar.style.left = `${(seg.start / DAY_MINUTES) * 100}%`;
      bar.style.width = `${((seg.end - seg.start) / DAY_MINUTES) * 100}%`;
      bar.dataset["window"] = String(s.blockWindows.indexOf(w));
      bar.title = `${w.label} · ${fmtTime(w.startHour, w.startMin)}–${fmtTime(w.endHour, w.endMin)}`;
      track.appendChild(bar);
    }

    if (today) {
      const minutes = now.getHours() * 60 + now.getMinutes();
      const marker = document.createElement("div");
      marker.className = "now absolute inset-y-0 w-0.5 rounded-[1px] bg-slate-50";
      marker.style.left = `${(minutes / DAY_MINUTES) * 100}%`;
      marker.title = `Now, ${fmtMinutes(minutes)}`;
      track.appendChild(marker);
    }

    row.append(name, track);
    return row;
  });

  const axis = document.createElement("div");
  axis.className = "mt-1 flex gap-3.5";
  const axisPad = document.createElement("span");
  axisPad.className = "w-[34px]";
  const hours = document.createElement("div");
  hours.className = "flex flex-1 justify-between font-mono text-[11px] text-faint";
  for (const hour of ["00", "06", "12", "18", "24"]) {
    const label = document.createElement("span");
    label.textContent = hour;
    hours.appendChild(label);
  }
  axis.append(axisPad, hours);

  week.replaceChildren(...rows, axis);
}

function renderWindows(s: GetStateResponse): void {
  const next = s.activeWindow ? null : getNextBlockWindowStart(new Date(), s.blockWindows);
  document
    .getElementById("windows-list")!
    .replaceChildren(...s.blockWindows.map((w, i) => buildWindowRow(w, i, w === next?.window)));
  document.getElementById("windows-empty")!.hidden = s.blockWindows.length > 0;
}

function buildWindowRow(w: BlockWindow, index: number, isNext: boolean): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "border-b border-line";
  li.dataset["window"] = String(index);

  const row = document.createElement("div");
  row.className = `${ROW_CLASS} py-3.5`;

  const left = document.createElement("div");
  left.className = "flex min-w-0 items-center gap-3.5";

  const overnight = crossesMidnight(w);
  const swatch = document.createElement("span");
  swatch.setAttribute("aria-hidden", "true");
  swatch.className = `size-2.5 shrink-0 rounded-[3px] ${overnight ? "bg-ember" : "bg-orange-400"}`;

  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "text-[15px] text-slate-100";
  title.textContent = w.label;
  if (isNext) {
    const badge = document.createElement("span");
    badge.className =
      "ml-2 rounded-full border border-edge bg-slate-900 px-2 py-0.5 text-[11px] text-slate-400";
    badge.textContent = "next";
    title.appendChild(badge);
  }

  const sub = document.createElement("div");
  sub.className = "text-[13px] text-slate-400";
  sub.append(
    `${fmtDays(w.days)} · `,
    mono(`${fmtTime(w.startHour, w.startMin)}–${fmtTime(w.endHour, w.endMin)}`),
  );
  if (overnight) sub.append(" next day");

  text.append(title, sub);
  left.append(swatch, text);

  const remove = iconButton(`Remove ${w.label}`, null);
  row.append(left, remove);

  // During a block, removing a window is a reason and a wait, like every loosening change.
  const form = document.createElement("div");
  form.hidden = true;
  form.className = "flex flex-col gap-2 px-5 pb-4";

  const textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = "Why do you need this?";
  textarea.setAttribute("aria-label", `Reason for removing ${w.label}`);
  textarea.className = "field h-auto w-full resize-none py-2.5 text-sm";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn-accent self-start";
  confirmBtn.textContent = "Queue removal";
  form.append(textarea, confirmBtn);

  const errEl = document.createElement("p");
  errEl.hidden = true;
  errEl.setAttribute("role", "alert");
  errEl.className = "px-5 pb-3 text-sm text-red-400";

  const sendRemoval = async (reason?: string): Promise<void> => {
    const s = state!;
    showError(
      errEl,
      errorOf(
        await sendMessage({
          type: "UPDATE_SETTINGS",
          blockWindows: s.blockWindows.filter((_, i) => i !== index),
          frictionDelayMs: s.frictionDelayMs,
          reason,
        }),
      ),
    );
  };

  remove.addEventListener("click", () => {
    showError(errEl, null);
    if (!state!.isBlocking) {
      void sendRemoval();
      return;
    }
    form.hidden = !form.hidden;
    if (!form.hidden) textarea.focus();
  });

  confirmBtn.addEventListener("click", () => {
    const reason = textarea.value.trim();
    if (!reason) {
      showError(errEl, "Enter a reason first.");
      return;
    }
    void sendRemoval(reason);
  });

  li.append(row, form, errEl);
  return li;
}

function initAddWindowForm(): void {
  const toggle = document.getElementById("add-window-toggle")!;
  const form = document.getElementById("add-window-form")!;
  const labelInput = document.getElementById("win-label") as HTMLInputElement;
  const startInput = document.getElementById("win-start") as HTMLInputElement;
  const endInput = document.getElementById("win-end") as HTMLInputElement;
  const errEl = document.getElementById("win-error")!;
  const dayBtns = [...document.querySelectorAll<HTMLButtonElement>(".day-btn")];

  const setOpen = (open: boolean): void => {
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", () => {
    setOpen(form.hidden);
    if (!form.hidden) labelInput.focus();
  });

  for (const btn of dayBtns) {
    btn.addEventListener("click", () => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("aria-pressed") !== "true"));
    });
  }

  document.getElementById("win-add-btn")!.addEventListener("click", async () => {
    showError(errEl, null);

    const days = dayBtns
      .filter((btn) => btn.getAttribute("aria-pressed") === "true")
      .map((btn) => Number(btn.dataset["day"]) as DayOfWeek);

    if (days.length === 0) {
      showError(errEl, "Select at least one day.");
      return;
    }

    if (!startInput.value || !endInput.value) {
      showError(errEl, "Set start and end times.");
      return;
    }

    const [startHour, startMin] = startInput.value.split(":").map(Number) as [number, number];
    const [endHour, endMin] = endInput.value.split(":").map(Number) as [number, number];

    const newWindow: BlockWindow = {
      label:
        labelInput.value.trim() || `${fmtTime(startHour, startMin)}–${fmtTime(endHour, endMin)}`,
      days,
      startHour,
      startMin,
      endHour,
      endMin,
    };

    const error = errorOf(
      await sendMessage({
        type: "UPDATE_SETTINGS",
        blockWindows: [...state!.blockWindows, newWindow],
        frictionDelayMs: state!.frictionDelayMs,
      }),
    );
    if (error !== null) {
      showError(errEl, error);
      return;
    }

    labelInput.value = "";
    startInput.value = "";
    endInput.value = "";
    for (const btn of dayBtns) btn.setAttribute("aria-pressed", "false");
    setOpen(false);
  });
}

// ── friction ──────────────────────────────────────────────────────────────────

function renderDelay(s: GetStateResponse): void {
  const input = document.getElementById("delay-input") as HTMLInputElement;
  // Leave a value the user is still working on alone.
  if (document.activeElement !== input && document.getElementById("delay-reason-row")!.hidden) {
    input.value = String(Math.round(s.frictionDelayMs / 60000));
  }
}

function initDelayControls(): void {
  const input = document.getElementById("delay-input") as HTMLInputElement;
  const errEl = document.getElementById("delay-error")!;
  const reasonRow = document.getElementById("delay-reason-row")!;
  const reasonInput = document.getElementById("delay-reason-input") as HTMLTextAreaElement;

  const readDelayMs = (): number | null => {
    const minutes = parseInt(input.value, 10);
    if (isNaN(minutes) || minutes < 1) {
      showError(errEl, "Enter a valid number of minutes (min 1).");
      return null;
    }
    return minutes * 60000;
  };

  const save = async (delayMs: number, reason?: string): Promise<void> => {
    const error = errorOf(
      await sendMessage({
        type: "UPDATE_SETTINGS",
        blockWindows: state!.blockWindows,
        frictionDelayMs: delayMs,
        reason,
      }),
    );
    showError(errEl, error);
    if (error === null) {
      reasonRow.hidden = true;
      reasonInput.value = "";
    }
  };

  document.getElementById("delay-save-btn")!.addEventListener("click", () => {
    showError(errEl, null);
    const delayMs = readDelayMs();
    if (delayMs === null) return;

    if (delayMs < state!.frictionDelayMs && state!.isBlocking) {
      reasonRow.hidden = false;
      reasonInput.focus();
      return;
    }
    void save(delayMs);
  });

  document.getElementById("delay-confirm-btn")!.addEventListener("click", () => {
    showError(errEl, null);
    const delayMs = readDelayMs();
    if (delayMs === null) return;

    const reason = reasonInput.value.trim();
    if (!reason) {
      showError(errEl, "Enter a reason first.");
      return;
    }
    void save(delayMs, reason);
  });
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function fetchState(): Promise<GetStateResponse | null> {
  const resp = await sendMessage({ type: "GET_STATE" }).catch(() => null);
  const failed = resp === null || "ok" in resp;
  document.getElementById("load-error")!.hidden = !failed;
  return failed ? null : resp;
}

async function reload(): Promise<void> {
  clearCountdowns();
  const s = await fetchState();
  if (s === null) return;

  state = s;
  renderStatus(s);
  renderPendingSettings(s);
  renderSites(s);
  renderWeek(s);
  renderWindows(s);
  renderDelay(s);
}

// A window starting or ending changes no storage, so the clock-driven parts refresh on their
// own. The window list is left alone: it may hold a half-typed reason.
async function refreshClock(): Promise<void> {
  const s = await fetchState();
  if (s === null) return;

  state = s;
  renderStatus(s);
  renderSites(s);
  renderWeek(s);
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") void reload();
});

setInterval(() => void refreshClock(), 60_000);

initAddSite();
initCancelSettings();
initAddWindowForm();
initDelayControls();

void reload();
