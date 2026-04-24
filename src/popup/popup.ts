import type {
  BlockWindow,
  DayOfWeek,
  GetStateResponse,
  PendingRemoval,
  PendingSettingsChange,
  RuntimeMessage,
  RuntimeResponse,
} from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtTime(hour: number, min: number): string {
  return `${pad(hour)}:${pad(min)}`;
}

function fmtCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${pad(s)}s`;
}

const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function fmtDays(days: DayOfWeek[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  // Check if contiguous weekdays Mon–Fri
  if (sorted.length === 5 && sorted.join() === "1,2,3,4,5") return "Mon–Fri";
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 2 && sorted.join() === "0,6") return "Weekends";
  return sorted.map((d) => DAY_ABBR[d]).join(", ");
}

function fmtWindow(w: BlockWindow): string {
  return `${fmtDays(w.days as DayOfWeek[])}  ·  ${fmtTime(w.startHour, w.startMin)}–${fmtTime(w.endHour, w.endMin)}`;
}

function normalizeDomainInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .split("?")[0]!
    .split("#")[0]!;
}

function isLikelyDomain(d: string): boolean {
  return d.includes(".") && !/\s/.test(d);
}

async function sendMessage(msg: RuntimeMessage): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(msg) as Promise<RuntimeResponse>;
}

// ── state ─────────────────────────────────────────────────────────────────────

let state: GetStateResponse | null = null;
const countdownTimers: number[] = [];

function clearTimers(): void {
  for (const id of countdownTimers) clearInterval(id);
  countdownTimers.length = 0;
}

// ── tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab: "sites" | "schedule"): void {
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
    const active = btn.dataset["tab"] === tab;
    btn.classList.toggle("text-slate-100", active);
    btn.classList.toggle("border-orange-400", active);
    btn.classList.toggle("text-slate-500", !active);
    btn.classList.toggle("border-transparent", !active);
  });

  document.getElementById(`tab-${tab}`)?.classList.remove("hidden");
}

// ── sites tab ─────────────────────────────────────────────────────────────────

function renderSites(s: GetStateResponse): void {
  const list = document.getElementById("sites-list")!;
  const empty = document.getElementById("sites-empty")!;
  const addRow = document.getElementById("add-site-row")!;
  const note = document.getElementById("block-window-note")!;

  list.innerHTML = "";
  addRow.classList.toggle("hidden", s.isBlocking);
  note.classList.toggle("hidden", !s.isBlocking);

  const banner = document.getElementById("block-banner")!;
  if (s.isBlocking && s.activeWindow) {
    banner.classList.remove("hidden");
    document.getElementById("block-banner-label")!.textContent = s.activeWindow.label;
    document.getElementById("block-banner-end")!.textContent =
      `ends at ${fmtTime(s.activeWindow.endHour, s.activeWindow.endMin)}`;
  } else {
    banner.classList.add("hidden");
  }

  if (s.sites.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  for (const domain of s.sites) {
    const pending = s.pendingRemovals.find((r) => r.domain === domain) ?? null;
    list.appendChild(buildSiteRow(domain, pending, s.isBlocking, s.frictionDelayMs));
  }
}

function buildSiteRow(
  domain: string,
  pending: PendingRemoval | null,
  isBlocking: boolean,
  _frictionDelayMs: number,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "flex flex-col gap-1 py-1.5 border-b border-slate-700/30 last:border-0";

  if (pending) {
    // Show countdown
    const row = document.createElement("div");
    row.className = "flex items-center justify-between";

    const left = document.createElement("span");
    left.className = "text-sm text-slate-400 italic truncate";
    left.textContent = domain;
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "flex items-center gap-2 shrink-0";

    const countdown = document.createElement("span");
    countdown.className = "text-xs font-mono text-amber-400";
    const update = (): void => {
      countdown.textContent = fmtCountdown(pending.applyAt - Date.now());
    };
    update();
    const id = setInterval(update, 1000) as unknown as number;
    countdownTimers.push(id);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-xs text-slate-500 hover:text-red-400 transition-colors";
    cancelBtn.textContent = "cancel";
    cancelBtn.addEventListener("click", async () => {
      await sendMessage({ type: "CANCEL_REMOVE", domain });
      await reload();
    });

    right.appendChild(countdown);
    right.appendChild(cancelBtn);
    row.appendChild(right);
    li.appendChild(row);
    return li;
  }

  const row = document.createElement("div");
  row.className = "flex items-center justify-between";

  const domainEl = document.createElement("span");
  domainEl.className = "text-sm text-slate-200 truncate";
  domainEl.textContent = domain;
  row.appendChild(domainEl);

  if (!isBlocking) {
    // Instant remove button
    const removeBtn = document.createElement("button");
    removeBtn.className =
      "shrink-0 text-slate-500 hover:text-red-400 transition-colors ml-2 text-base leading-none";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async () => {
      await sendMessage({ type: "QUEUE_REMOVE", domain, reason: "" });
      await reload();
    });
    row.appendChild(removeBtn);
    li.appendChild(row);
  } else {
    // Locked: show "Request removal" button that opens intention form
    const requestBtn = document.createElement("button");
    requestBtn.className =
      "shrink-0 text-xs text-amber-400 hover:text-amber-200 transition-colors ml-2";
    requestBtn.textContent = "Request removal";

    const form = document.createElement("div");
    form.className = "hidden flex-col gap-1.5 mt-1";

    const textarea = document.createElement("textarea");
    textarea.rows = 2;
    textarea.placeholder = "Why do you need this?";
    textarea.className =
      "w-full bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500/60 transition-colors resize-none";

    const confirmBtn = document.createElement("button");
    confirmBtn.className =
      "py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-colors";
    confirmBtn.textContent = "Queue removal";

    form.appendChild(textarea);
    form.appendChild(confirmBtn);

    requestBtn.addEventListener("click", () => {
      form.classList.toggle("hidden");
      form.classList.toggle("flex");
    });

    confirmBtn.addEventListener("click", async () => {
      const reason = textarea.value.trim();
      if (!reason) {
        textarea.classList.add("border-red-500/60");
        return;
      }
      await sendMessage({ type: "QUEUE_REMOVE", domain, reason });
      await reload();
    });

    row.appendChild(requestBtn);
    li.appendChild(row);
    li.appendChild(form);
  }

  return li;
}

// ── schedule tab ──────────────────────────────────────────────────────────────

function renderSchedule(s: GetStateResponse): void {
  renderWindows(s);
  renderPendingSettings(s.pendingSettingsChange);

  const delayInput = document.getElementById("delay-input") as HTMLInputElement;
  delayInput.value = String(Math.round(s.frictionDelayMs / 60000));

  // Dim schedule controls when a pending change is queued
  const locked = s.pendingSettingsChange !== null;
  const windowsList = document.getElementById("windows-list")!;
  windowsList.classList.toggle("opacity-40", locked);
  windowsList.classList.toggle("pointer-events-none", locked);

  const addWindowDetails = document.getElementById("add-window-details")!;
  addWindowDetails.classList.toggle("opacity-40", locked);
  addWindowDetails.classList.toggle("pointer-events-none", locked);

  const delaySection = document.querySelector<HTMLElement>(".border-t.border-slate-700\\/40");
  delaySection?.classList.toggle("opacity-40", locked);
  delaySection?.classList.toggle("pointer-events-none", locked);
}

function renderWindows(s: GetStateResponse): void {
  const list = document.getElementById("windows-list")!;
  const empty = document.getElementById("windows-empty")!;
  list.innerHTML = "";

  if (s.blockWindows.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  for (let i = 0; i < s.blockWindows.length; i++) {
    const w = s.blockWindows[i]!;
    list.appendChild(buildWindowRow(w, i, s));
  }
}

function buildWindowRow(w: BlockWindow, index: number, s: GetStateResponse): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "flex flex-col gap-1 py-1.5 border-b border-slate-700/30 last:border-0";

  const row = document.createElement("div");
  row.className = "flex items-center justify-between";

  const label = document.createElement("div");
  label.className = "flex flex-col";

  const title = document.createElement("span");
  title.className = "text-sm text-slate-200";
  title.textContent = w.label || fmtWindow(w);

  const sub = document.createElement("span");
  sub.className = "text-xs text-slate-500";
  sub.textContent = fmtWindow(w);

  label.appendChild(title);
  if (w.label) label.appendChild(sub);
  row.appendChild(label);

  const removeBtn = document.createElement("button");
  removeBtn.className =
    "shrink-0 text-slate-500 hover:text-red-400 transition-colors ml-2 text-base leading-none";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove window";

  const form = document.createElement("div");
  form.className = "hidden flex-col gap-1.5 mt-1";

  removeBtn.addEventListener("click", async () => {
    if (!s.isBlocking) {
      // instant
      const newWindows = s.blockWindows.filter((_, i) => i !== index);
      await sendMessage({
        type: "UPDATE_SETTINGS",
        blockWindows: newWindows,
        frictionDelayMs: s.frictionDelayMs,
      });
      await reload();
    } else {
      form.classList.toggle("hidden");
      form.classList.toggle("flex");
    }
  });

  const textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = "Why do you need this?";
  textarea.className =
    "w-full bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500/60 transition-colors resize-none";

  const confirmBtn = document.createElement("button");
  confirmBtn.className =
    "py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-colors";
  confirmBtn.textContent = "Queue removal";

  confirmBtn.addEventListener("click", async () => {
    const reason = textarea.value.trim();
    if (!reason) {
      textarea.classList.add("border-red-500/60");
      return;
    }
    const newWindows = s.blockWindows.filter((_, i) => i !== index);
    const resp = await sendMessage({
      type: "UPDATE_SETTINGS",
      blockWindows: newWindows,
      frictionDelayMs: s.frictionDelayMs,
      reason,
    });
    if ("ok" in resp && !resp.ok) {
      textarea.value = "";
      textarea.placeholder = (resp as { error: string }).error;
    } else {
      await reload();
    }
  });

  form.appendChild(textarea);
  form.appendChild(confirmBtn);

  row.appendChild(removeBtn);
  li.appendChild(row);
  li.appendChild(form);
  return li;
}

function renderPendingSettings(pending: PendingSettingsChange | null): void {
  const banner = document.getElementById("pending-settings-banner")!;

  if (!pending) {
    banner.classList.add("hidden");
    return;
  }

  banner.classList.remove("hidden");
  const countdown = document.getElementById("pending-settings-countdown")!;
  const update = (): void => {
    countdown.textContent = fmtCountdown(pending.applyAt - Date.now());
  };
  update();
  const id = setInterval(update, 1000) as unknown as number;
  countdownTimers.push(id);
}

// ── add window form ────────────────────────────────────────────────────────────

function initAddWindowForm(): void {
  const dayBtns = document.querySelectorAll<HTMLButtonElement>(".day-btn");
  dayBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const active = btn.classList.contains("bg-orange-500/30");
      btn.classList.toggle("bg-orange-500/30", !active);
      btn.classList.toggle("text-orange-300", !active);
      btn.classList.toggle("border-orange-500/40", !active);
      btn.classList.toggle("bg-slate-700/40", active);
      btn.classList.toggle("text-slate-400", active);
    });
  });

  const addBtn = document.getElementById("win-add-btn")!;
  const errEl = document.getElementById("win-error")!;

  addBtn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    errEl.textContent = "";

    const label = (document.getElementById("win-label") as HTMLInputElement).value.trim();
    const startVal = (document.getElementById("win-start") as HTMLInputElement).value;
    const endVal = (document.getElementById("win-end") as HTMLInputElement).value;

    const selectedDays: DayOfWeek[] = [];
    dayBtns.forEach((btn) => {
      if (btn.classList.contains("bg-orange-500/30")) {
        selectedDays.push(Number(btn.dataset["day"]) as DayOfWeek);
      }
    });

    if (selectedDays.length === 0) {
      errEl.textContent = "Select at least one day.";
      errEl.classList.remove("hidden");
      return;
    }

    if (!startVal || !endVal) {
      errEl.textContent = "Set start and end times.";
      errEl.classList.remove("hidden");
      return;
    }

    const [startHour, startMin] = startVal.split(":").map(Number) as [number, number];
    const [endHour, endMin] = endVal.split(":").map(Number) as [number, number];

    if (startHour * 60 + startMin >= endHour * 60 + endMin) {
      errEl.textContent = "End time must be after start time.";
      errEl.classList.remove("hidden");
      return;
    }

    const newWindow: BlockWindow = {
      label: label || `${fmtTime(startHour, startMin)}–${fmtTime(endHour, endMin)}`,
      days: selectedDays,
      startHour,
      startMin,
      endHour,
      endMin,
    };

    await sendMessage({
      type: "UPDATE_SETTINGS",
      blockWindows: [...state!.blockWindows, newWindow],
      frictionDelayMs: state!.frictionDelayMs,
    });

    // reset form
    (document.getElementById("win-label") as HTMLInputElement).value = "";
    (document.getElementById("win-start") as HTMLInputElement).value = "";
    (document.getElementById("win-end") as HTMLInputElement).value = "";
    dayBtns.forEach((btn) => {
      btn.classList.remove("bg-orange-500/30", "text-orange-300", "border-orange-500/40");
      btn.classList.add("bg-slate-700/40", "text-slate-400");
    });
    (document.getElementById("add-window-details") as HTMLDetailsElement).open = false;

    await reload();
  });
}

// ── delay controls ─────────────────────────────────────────────────────────────

function initDelayControls(): void {
  const saveBtn = document.getElementById("delay-save-btn")!;
  const delayInput = document.getElementById("delay-input") as HTMLInputElement;
  const errEl = document.getElementById("delay-error")!;
  const reasonRow = document.getElementById("delay-reason-row")!;
  const reasonInput = document.getElementById("delay-reason-input") as HTMLTextAreaElement;
  const confirmBtn = document.getElementById("delay-confirm-btn")!;

  saveBtn.addEventListener("click", () => {
    errEl.classList.add("hidden");
    const minutes = parseInt(delayInput.value, 10);

    if (isNaN(minutes) || minutes < 1) {
      errEl.textContent = "Enter a valid number of minutes (min 1).";
      errEl.classList.remove("hidden");
      return;
    }

    const s = state!;
    const newDelayMs = minutes * 60000;
    const isWeakening = newDelayMs < s.frictionDelayMs;

    if (isWeakening && s.isBlocking) {
      reasonRow.classList.remove("hidden");

      confirmBtn.onclick = async () => {
        const reason = reasonInput.value.trim();
        if (!reason) {
          reasonInput.classList.add("border-red-500/60");
          return;
        }
        const resp = await sendMessage({
          type: "UPDATE_SETTINGS",
          blockWindows: s.blockWindows,
          frictionDelayMs: newDelayMs,
          reason,
        });
        if ("ok" in resp && !resp.ok) {
          errEl.textContent = (resp as { error: string }).error;
          errEl.classList.remove("hidden");
        } else {
          reasonRow.classList.add("hidden");
          reasonInput.value = "";
          await reload();
        }
      };
    } else {
      void (async () => {
        const resp = await sendMessage({
          type: "UPDATE_SETTINGS",
          blockWindows: s.blockWindows,
          frictionDelayMs: newDelayMs,
        });
        if ("ok" in resp && !resp.ok) {
          errEl.textContent = (resp as { error: string }).error;
          errEl.classList.remove("hidden");
        } else {
          await reload();
        }
      })();
    }
  });
}

// ── add site ──────────────────────────────────────────────────────────────────

function initAddSite(): void {
  const input = document.getElementById("add-input") as HTMLInputElement;
  const btn = document.getElementById("add-btn")!;
  const errEl = document.getElementById("add-error")!;

  const submit = async (): Promise<void> => {
    errEl.classList.add("hidden");
    const domain = normalizeDomainInput(input.value);

    if (!isLikelyDomain(domain)) {
      errEl.textContent = "Enter a valid domain (e.g. reddit.com).";
      errEl.classList.remove("hidden");
      return;
    }

    const resp = await sendMessage({ type: "ADD_SITE", domain });

    if ("ok" in resp && !resp.ok) {
      errEl.textContent = (resp as { error: string }).error;
      errEl.classList.remove("hidden");
      return;
    }

    input.value = "";
    const addRow = document.getElementById("add-site-row")!;
    addRow.classList.add("bg-green-500/10", "rounded-lg", "transition-colors");
    setTimeout(() => addRow.classList.remove("bg-green-500/10"), 1000);
    await reload();
  };

  btn.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
}

// ── cancel settings ───────────────────────────────────────────────────────────

function initCancelSettings(): void {
  document.getElementById("cancel-settings-btn")!.addEventListener("click", async () => {
    await sendMessage({ type: "CANCEL_SETTINGS" });
    await reload();
  });
}

// ── status dot ────────────────────────────────────────────────────────────────

function renderStatusDot(s: GetStateResponse): void {
  const dot = document.getElementById("status-dot")!;
  const label = document.getElementById("status-label")!;

  if (s.isBlocking && s.activeWindow) {
    dot.classList.remove("hidden");
    dot.classList.add("flex");
    label.textContent = s.activeWindow.label;
  } else {
    dot.classList.add("hidden");
    dot.classList.remove("flex");
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function reload(): Promise<void> {
  clearTimers();
  const resp = await sendMessage({ type: "GET_STATE" });
  state = resp as GetStateResponse;
  renderStatusDot(state);
  renderSites(state);
  renderSchedule(state);
}

document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset["tab"] as "sites" | "schedule");
  });
});

initAddSite();
initCancelSettings();
initAddWindowForm();
initDelayControls();

void reload();
