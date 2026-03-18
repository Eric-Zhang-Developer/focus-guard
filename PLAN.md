# Focus Guard MLP Plan

## Goal

Ship a minimum lovable product for a Chrome extension that blocks configured domains and subdomains, enforces user-editable focus windows, and adds deliberate friction to weakening changes during active blocks.

## Product Standard

The MLP is successful when:

- blocked domains and subdomains reliably redirect during active focus windows
- the popup feels simple and dependable
- bypassing is possible but slow enough to kill impulsive behavior
- schedule and friction delay are editable in the popup — no code changes required
- the extension survives MV3 service worker sleep without losing core behavior

---

## Phase 0: Foundation And Constraints ✅

Set up the project so the extension can build, load in Chrome, and support MV3 correctly.

- `package.json`, `tsconfig.json`, `vite.config.ts` with CRXJS + Tailwind v4
- `manifest.json` with MV3 permissions, popup, background worker, DNR resources
- `rules.json` as empty array, placeholder icons

---

## Phase 1: Shared Models And Default Config ✅

Define the core data model. Config values are defaults only — runtime state lives in storage.

- `src/types.ts` — `StorageSchema` includes `blockedSites`, `blockWindows`, `frictionDelayMs`, `pendingRemovals`, `pendingSettingsChange`
- `src/config.ts` — `DEFAULT_BLOCK_WINDOWS` and `DEFAULT_FRICTION_DELAY_MS` used only to seed storage on first install

---

## Phase 2: Background Worker Core ✅

Build the extension's reliable control plane in the service worker.

- initialize storage on install with defaults from config
- `isInBlockWindow(now, blockWindows)` — reads windows from storage, not config
- `syncRules()` — regenerates dynamic DNR rules with `?domain=` param in redirect
- minute alarm via `chrome.alarms`
- `reconcilePending()` — applies expired pending removals AND pending settings changes
- message handlers: `GET_STATE`, `ADD_SITE`, `QUEUE_REMOVE`, `CANCEL_REMOVE`, `UPDATE_SETTINGS`, `CANCEL_SETTINGS`
- `isWeakeningSettingsChange()` — determines if a settings update requires friction

---

## Phase 3: Blocked Page ✅

Show a polished blocked experience with domain and window context.

- `blocked.html` — Tailwind-styled dark card, amber glow background
- `src/blocked.ts` — reads `?domain=` param, reads storage for active window, populates DOM
- `src/blocked.css` — Tailwind entry point

---

## Phase 4 + 5: Popup — Sites + Schedule + Friction ✅

Full popup with two tabs.

**Sites tab**
- Status banner when in a block window (label + end time)
- Blocked sites list — instant ✕ outside block window; "Request removal" + intention textarea + countdown inside
- Add site input with domain sanitization and validation (hidden during block window)
- Pending removal rows show live countdown + cancel

**Schedule tab**
- Block windows list — instant ✕ outside block window; intention prompt + friction inside
- Add block window form: label, day toggles, start/end time — always instant (strengthening)
- Friction delay input (minutes) — instant if increasing; intention prompt + friction if reducing during block
- Pending settings change banner: live countdown + cancel button

---

## Phase 6: End-To-End Validation

Prove the core user promise works in Chrome.

### Manual Test Pass

1. build and load `dist/` unpacked
2. add `reddit.com` in Sites tab
3. verify `reddit.com` redirects to `blocked.html` during a block window
4. verify `old.reddit.com` is also blocked
5. verify removal is instant outside a block window
6. verify removal during a block window requires a typed reason and shows countdown
7. cancel a pending removal — confirm site stays blocked
8. add a block window in Schedule tab — confirm it appears and applies instantly
9. remove a block window during an active block — confirm friction applies
10. reduce friction delay during active block — confirm friction applies
11. close and reopen popup — confirm countdowns resume from correct `applyAt`
12. let service worker sleep — confirm pending changes still apply via alarm

---

## Phase 7: Polish For MLP

Tighten the product so it feels intentional instead of merely functional.

- review popup copy and empty states
- ensure blocked page and popup look consistent
- add guardrails for duplicate domains, duplicate pending removals
- verify all failure paths show useful inline errors

---

## MLP Scope Boundary

Keep these out of the first release:

- pause-all mode
- import/export
- analytics
- cloud sync beyond `chrome.storage.sync`
- category presets
- password locks
- cross-browser support beyond Chrome

---

## Definition Of Done

The MLP is done when a user can install the extension, configure their own block schedule and sites in the popup, get redirected during focus windows, and can only bypass the block by waiting through a deliberate delay — long enough to kill impulsive behavior.
