import type { GetStateResponse, PendingRemoval } from "../types";
import { isLikelyDomain, isPassOpen, normalizeDomain } from "../background-core";
import { clearCountdowns, fmtTime, sendMessage, startCountdown as startUiCountdown } from "../ui";

// ── sites ─────────────────────────────────────────────────────────────────────

function renderSites(s: GetStateResponse): void {
  const list = document.getElementById("sites-list")!;
  const empty = document.getElementById("sites-empty")!;

  list.innerHTML = "";

  const banner = document.getElementById("block-banner")!;
  if (s.isBlocking && s.activeWindow && !s.focusSession) {
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
    list.appendChild(buildSiteRow(domain, pending, s));
  }
}

function startCountdown(el: HTMLElement, until: number): void {
  startUiCountdown(el, until, () => void reload());
}

const FIELD_CLASS =
  "bg-slate-800/60 border border-slate-700/60 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-orange-500/60 transition-colors";

function buildSiteRow(
  domain: string,
  pending: PendingRemoval | null,
  s: GetStateResponse,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "flex flex-col gap-1 py-1.5 border-b border-slate-700/30 last:border-0";

  if (pending) {
    // Waiting (for a pass or a removal) or open on a pass.
    const open = isPassOpen(pending);
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-2";

    const left = document.createElement("span");
    left.className = open
      ? "text-sm text-emerald-300 truncate"
      : "text-sm text-slate-400 italic truncate";
    left.textContent = domain;
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "flex items-center gap-2 shrink-0";

    const status = document.createElement("span");
    status.className = `text-xs font-mono ${open ? "text-emerald-400" : "text-amber-400"}`;
    const countdown = document.createElement("span");

    if (open) {
      status.append("open for ", countdown);
      startCountdown(countdown, pending.reblockAt!);
    } else {
      const kind =
        pending.reblockAt === undefined
          ? "removal"
          : `${Math.round((pending.reblockAt - pending.applyAt) / 60000)} min pass`;
      status.append(`${kind} in `, countdown);
      startCountdown(countdown, pending.applyAt);
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-xs text-slate-500 hover:text-red-400 transition-colors";
    cancelBtn.textContent = open ? "end now" : "cancel";
    cancelBtn.addEventListener("click", async () => {
      await sendMessage({ type: "CANCEL_REMOVE", domain });
      await reload();
    });

    right.appendChild(status);
    right.appendChild(cancelBtn);
    row.appendChild(right);
    li.appendChild(row);
    return li;
  }

  const focusOnly = s.focusOnlySites.includes(domain);
  // Same answer as the background's isSiteEnforced: a focus-only site is open in a plain
  // window, so it can be removed there without a wait.
  const locked = s.isBlocking && (s.focusSession !== null || !focusOnly);

  const row = document.createElement("div");
  row.className = "flex items-center justify-between";

  const domainEl = document.createElement("span");
  domainEl.className = `text-sm truncate ${focusOnly && !s.focusSession ? "text-slate-500" : "text-slate-200"}`;
  domainEl.textContent = domain;
  row.appendChild(domainEl);

  if (focusOnly) {
    const tag = document.createElement("span");
    tag.className = "ml-auto shrink-0 text-xs text-slate-500";
    tag.textContent = "focus only";
    row.appendChild(tag);
  }

  if (!locked) {
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
    return li;
  }

  // Locked: a reason and a wait, for a pass of the chosen length or, with no length, for good.
  const requestBtn = document.createElement("button");
  requestBtn.className =
    "shrink-0 text-xs text-amber-400 hover:text-amber-200 transition-colors ml-2";
  requestBtn.textContent = "Request removal";

  const form = document.createElement("div");
  form.className = "hidden flex-col gap-1.5 mt-1";

  const textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = "What do you need it for?";
  textarea.setAttribute("aria-label", `Reason for unblocking ${domain}`);
  textarea.className = `w-full px-3 py-2 text-xs resize-none ${FIELD_CLASS}`;

  const lengthRow = document.createElement("label");
  lengthRow.className = "flex items-center gap-2 text-xs text-slate-400";
  const minutesInput = document.createElement("input");
  minutesInput.type = "number";
  minutesInput.min = "1";
  minutesInput.step = "any";
  minutesInput.value = "15";
  minutesInput.className = `w-16 px-2 py-1 text-xs ${FIELD_CLASS}`;
  lengthRow.append("Unblock for", minutesInput, "min");

  const hint = document.createElement("p");
  hint.className = "text-xs text-slate-500";
  hint.textContent = "Leave empty to remove it for good.";

  const errEl = document.createElement("p");
  errEl.className = "hidden text-xs text-red-400";

  const confirmBtn = document.createElement("button");
  confirmBtn.className =
    "py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-colors";
  confirmBtn.textContent = `Start ${Math.round(s.frictionDelayMs / 60000)} min wait`;

  form.append(textarea, lengthRow, hint, errEl, confirmBtn);

  requestBtn.addEventListener("click", () => {
    form.classList.toggle("hidden");
    form.classList.toggle("flex");
  });

  const showError = (message: string): void => {
    errEl.textContent = message;
    errEl.classList.remove("hidden");
  };

  form.addEventListener("input", () => {
    errEl.classList.add("hidden");
    textarea.classList.remove("border-red-500/60");
  });

  confirmBtn.addEventListener("click", async () => {
    const reason = textarea.value.trim();
    if (!reason) {
      textarea.classList.add("border-red-500/60");
      showError("Enter a reason first.");
      return;
    }

    const rawMinutes = minutesInput.value.trim();
    const minutes = rawMinutes === "" ? undefined : Number(rawMinutes);
    // An empty box with invalid typed text also reads as "", so check the browser's verdict too.
    if (!minutesInput.validity.valid || (minutes !== undefined && !(minutes > 0))) {
      showError("Enter a number of minutes, or leave it empty.");
      return;
    }

    const resp = await sendMessage({ type: "QUEUE_REMOVE", domain, reason, minutes });
    if ("ok" in resp && !resp.ok) {
      showError(resp.error);
      return;
    }
    await reload();
  });

  row.appendChild(requestBtn);
  li.appendChild(row);
  li.appendChild(form);
  return li;
}

// ── focus session ─────────────────────────────────────────────────────────────

function renderFocus(s: GetStateResponse): void {
  const session = s.focusSession;
  const ending = session?.endingEarly !== undefined;
  const form = document.getElementById("focus-end-form")!;

  document.getElementById("focus-start")!.classList.toggle("hidden", session !== null);
  document.getElementById("focus-banner")!.classList.toggle("hidden", session === null);
  document.getElementById("focus-extend-btn")!.classList.toggle("hidden", ending);
  document.getElementById("focus-end-btn")!.classList.toggle("hidden", ending);
  document.getElementById("focus-cancel-end-btn")!.classList.toggle("hidden", !ending);
  document.getElementById("focus-end-confirm")!.textContent =
    `Start ${Math.round(s.frictionDelayMs / 60000)} min wait`;

  if (session === null || ending) {
    form.classList.add("hidden");
    form.classList.remove("flex");
  }

  if (session === null) return;

  const countdown = document.createElement("span");
  const status = document.getElementById("focus-banner-status")!;
  if (ending) status.replaceChildren("ending in ", countdown);
  else status.replaceChildren(countdown, " left");
  startCountdown(countdown, session.endsAt);
}

function initFocus(): void {
  const minutesInput = document.getElementById("focus-minutes") as HTMLInputElement;
  const startErr = document.getElementById("focus-start-error")!;
  const form = document.getElementById("focus-end-form")!;
  const reasonInput = document.getElementById("focus-end-reason") as HTMLTextAreaElement;
  const endErr = document.getElementById("focus-end-error")!;

  const showError = (el: HTMLElement, message: string): void => {
    el.textContent = message;
    el.classList.remove("hidden");
  };

  minutesInput.addEventListener("input", () => startErr.classList.add("hidden"));

  document.getElementById("focus-start-btn")!.addEventListener("click", async () => {
    const minutes = Number(minutesInput.value.trim());
    // An empty box with invalid typed text also reads as "", so check the browser's verdict too.
    if (!minutesInput.validity.valid || !(minutes > 0)) {
      showError(startErr, "Enter a number of minutes.");
      return;
    }

    const resp = await sendMessage({ type: "START_FOCUS", minutes });
    if ("ok" in resp && !resp.ok) {
      showError(startErr, resp.error);
      return;
    }
    await reload();
  });

  document.getElementById("focus-extend-btn")!.addEventListener("click", async () => {
    await sendMessage({ type: "START_FOCUS", minutes: 15 });
    await reload();
  });

  document.getElementById("focus-end-btn")!.addEventListener("click", () => {
    form.classList.toggle("hidden");
    form.classList.toggle("flex");
  });

  document.getElementById("focus-cancel-end-btn")!.addEventListener("click", async () => {
    await sendMessage({ type: "CANCEL_END_FOCUS" });
    await reload();
  });

  reasonInput.addEventListener("input", () => {
    endErr.classList.add("hidden");
    reasonInput.classList.remove("border-red-500/60");
  });

  document.getElementById("focus-end-confirm")!.addEventListener("click", async () => {
    const reason = reasonInput.value.trim();
    if (!reason) {
      reasonInput.classList.add("border-red-500/60");
      showError(endErr, "Enter a reason first.");
      return;
    }

    const resp = await sendMessage({ type: "END_FOCUS", reason });
    if ("ok" in resp && !resp.ok) {
      showError(endErr, resp.error);
      return;
    }
    reasonInput.value = "";
    await reload();
  });
}

// ── add site ──────────────────────────────────────────────────────────────────

function initAddSite(): void {
  const input = document.getElementById("add-input") as HTMLInputElement;
  const btn = document.getElementById("add-btn")!;
  const errEl = document.getElementById("add-error")!;

  const submit = async (): Promise<void> => {
    errEl.classList.add("hidden");
    const domain = normalizeDomain(input.value);

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

// ── status dot ────────────────────────────────────────────────────────────────

function renderStatusDot(s: GetStateResponse): void {
  const dot = document.getElementById("status-dot")!;
  const label = document.getElementById("status-label")!;

  const text = s.focusSession ? "Focus session" : s.activeWindow?.label;

  if (s.isBlocking && text !== undefined) {
    dot.classList.remove("hidden");
    dot.classList.add("flex");
    label.textContent = text;
  } else {
    dot.classList.add("hidden");
    dot.classList.remove("flex");
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function reload(): Promise<void> {
  clearCountdowns();
  const resp = await sendMessage({ type: "GET_STATE" }).catch(() => null);
  const failed = resp === null || "ok" in resp;
  document.getElementById("load-error")!.classList.toggle("hidden", !failed);
  if (failed) return;

  renderStatusDot(resp);
  renderFocus(resp);
  renderSites(resp);
}

document.getElementById("settings-link")!.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

initAddSite();
initFocus();

void reload();
