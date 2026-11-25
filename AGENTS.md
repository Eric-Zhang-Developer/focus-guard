# AGENTS.md — Focus Guard Chrome Extension

A Chrome Extension (Manifest V3) site + subdomain blocker with time-based scheduling and
deliberate friction to prevent impulsive disabling. Built with TypeScript + Vite + CRXJS.

---

## Project Goals

- Block domains and all their subdomains
- Allow list: an address inside a blocked site that stays open (`music.youtube.com` while
  `youtube.com` is blocked)
- Time-based blocking windows (user-editable on the settings page)
- Ad-hoc focus sessions ("focus for 45 min"); a site can be flagged focus only, so it is
  blocked in sessions but not in scheduled windows
- Friction layer: weakening changes during a block window require deliberate effort, not a single click
- Local only — no server, no auth, no backend
- Clean minimal UI: the popup for things done during the day, a full-tab settings page for
  things set up once

---

## Friction Design (read this carefully before building)

The user wants it to be _possible_ but _annoying_ to bypass. The goal is to create
enough resistance to kill impulsive disabling, while not being so locked down that
it causes genuine frustration in a real emergency.

### Chosen Friction Mechanisms

**1. Commitment Delay (primary)**
When the user makes a _weakening_ change during an active block window (remove a site,
remove/edit a block window, reduce the friction delay), the change is not applied immediately.
Instead it is queued with the configured delay (default 10 minutes).
A countdown is shown in the popup (or on the settings page for a settings change). The user can cancel the queued change within that window.
After the delay, the change applies automatically via `chrome.alarms`.

Why this works: impulse to check social media dies in 10 minutes. Real emergencies don't.

**2. Intention Prompt (secondary)**
Before queuing a delay, the user must type a short reason phrase into a text box.
Example: "I need to check this for work"
The text is never validated — it doesn't need to be. The act of typing it creates
conscious friction and breaks the autopilot loop.

**3. Schedule-Aware UI States**
The popup and the settings page have two distinct modes:

- **Outside block window**: normal UI, add/remove sites freely, edit schedule freely, no friction
- **Inside block window or focus session**: weakening changes (remove site, remove window, reduce delay,
  end a session early) require intention prompt + delay; strengthening changes (add site, add window,
  increase delay, start or extend a session) are always instant

**4. Friction applies to weakening changes only**
- Removing a blocked site → friction if the site is blocked right now (in a session, or in a
  block window and not focus only)
- Removing or editing a block window → friction if in block window
- Reducing the friction delay → friction if in block window
- Adding a site → always instant
- Adding a new block window → always instant
- Increasing the friction delay → always instant
- Starting or extending a focus session → always instant (extending also cancels a pending early end)
- Ending a focus session early → reason + delay, cancelable
- Flagging a site "always" → always instant
- Flagging a site "focus only" → refused while a window or session is active (not queued)
- Allowing an address → refused while a window or session is active (not queued)
- Stopping allowing an address → always instant

---

## Tech Stack

```
TypeScript (strict)
Vite + @crxjs/vite-plugin     — build + hot reload
Tailwind CSS v4                — utility classes via @tailwindcss/vite plugin
Chrome Extension Manifest V3
declarativeNetRequest API      — network-level blocking (efficient, no page injection needed)
chrome.storage.sync            — persists blocklist, schedule, settings + pending changes
chrome.alarms                  — schedule checks (survives service worker sleep)
```

### Key MV3 Gotcha

Service workers sleep after ~30s inactivity. NEVER use `setInterval` or `setTimeout`
for schedule checking. Always use `chrome.alarms`.

---

## File Structure

```
focus-guard/
├── src/
│   ├── background.ts          — service worker, rule syncing, alarm handling
│   ├── background-core.ts     — pure business logic (testable, no Chrome APIs)
│   ├── config.ts              — DEFAULT_BLOCK_WINDOWS + DEFAULT_FRICTION_DELAY_MS (seed values only)
│   ├── types.ts               — shared TypeScript types
│   ├── blocked.ts             — blocked page script
│   ├── blocked.css            — Tailwind entry for blocked page
│   ├── ui.ts                  — helpers shared by popup and settings page (format, sendMessage, countdowns)
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css          — Tailwind entry for popup
│   │   └── popup.ts
│   └── options/               — settings page (manifest options_page)
│       ├── options.html
│       ├── options.css        — Tailwind entry + design tokens, keyframes
│       └── options.ts
├── blocked.html               — shown instead of blocked site
├── rules.json                 — empty array, baseline for declarativeNetRequest
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── manifest.json
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## `src/config.ts` — Default Values Only

```ts
export const DEFAULT_BLOCK_WINDOWS: BlockWindow[] = [
  {
    label: "Deep Work Morning",
    days: [1, 2, 3, 4, 5], // Mon–Fri
    startHour: 9, startMin: 0,
    endHour: 12, endMin: 0,
  },
  {
    label: "Afternoon Focus",
    days: [1, 2, 3, 4, 5],
    startHour: 14, startMin: 0,
    endHour: 17, endMin: 0,
  },
];

export const DEFAULT_FRICTION_DELAY_MS = 10 * 60 * 1000; // 10 minutes
```

> These values are only used to seed `chrome.storage.sync` on first install.
> At runtime, all settings are read from storage. Users edit them on the settings page.

---

## `src/types.ts`

```ts
export interface PendingRemoval {
  domain: string;
  reason: string;
  scheduledAt: number;
  applyAt: number;
  reblockAt?: number; // set for a pass: open from applyAt, blocked again at reblockAt
}

export interface PendingSettingsChange {
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  reason: string;
  scheduledAt: number;
  applyAt: number;
}

export interface FocusSession {
  endsAt: number;
  // set while an early end waits: endsAt pulled in, cancel restores originalEndsAt
  endingEarly?: { reason: string; originalEndsAt: number };
}

export interface StorageSchema {
  blockedSites: string[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingRemovals: PendingRemoval[];
  pendingSettingsChange: PendingSettingsChange | null;
  focusOnlySites: string[]; // subset of blockedSites, blocked only in a focus session
  focusSession: FocusSession | null;
  allowedSites: string[]; // each a strict subdomain of a blocked site (canAllow)
}
```

---

## `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Focus Guard",
  "version": "1.0.0",
  "description": "Block distracting sites with built-in friction",

  "permissions": [
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
    "storage",
    "alarms"
  ],

  "host_permissions": ["<all_urls>"],

  "background": {
    "service_worker": "src/background.ts",
    "type": "module"
  },

  "options_page": "src/options/options.html",

  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },

  "declarative_net_request": {
    "rule_resources": [
      {
        "id": "blocklist",
        "enabled": true,
        "path": "rules.json"
      }
    ]
  },

  "web_accessible_resources": [
    {
      "resources": ["blocked.html"],
      "matches": ["<all_urls>"]
    }
  ],

  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

---

## `src/background.ts` — Core Logic

### Responsibilities

1. On install/startup: initialise storage with defaults, set up alarms, sync rules
2. `chrome.alarms.onAlarm` — every minute: apply expired pending removals and pending settings changes
3. `chrome.runtime.onMessage` — handle popup and settings page messages
4. `syncRules()` — rebuild declarativeNetRequest dynamic rules from current blockedSites

### Subdomain Blocking

`declarativeNetRequest` urlFilter syntax `||domain.com^` already matches all subdomains
and the apex domain. No extra work needed — just use that pattern.

### Allow list

An allowed address is an exception inside a blocked site. `canAllow` in `background-core.ts`
is the one rule: an entry must be a strict subdomain of some blocked site, and never equal to
or a parent of one, so an exception can never switch a whole block off. Adding a blocked site
that breaks it (blocking the allowed address itself) drops the entry; removing a blocked site
(instantly or by an applied queued removal) drops entries left outside every blocked site. A
pass removes nothing. `normalizeStorage` re-applies the rule on every read.

`buildDynamicRules` adds an `allow` rule at priority 2 (redirects are priority 1) for each entry
inside a site blocked right now, so allow wins over block. Tab checks go through
`getBlockedDomainForUrl`, which returns null for a host under an allowed entry.

### Message API (popup / settings page → background)

| type              | payload                                              | returns                                                                    |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET_STATE`       | —                                                    | `{ sites, allowedSites, pendingRemovals, blockWindows, frictionDelayMs, pendingSettingsChange, focusOnlySites, focusSession, isBlocking, activeWindow }` — `isBlocking` is true in a window or a session |
| `ADD_SITE`        | `{ domain }`                                         | `{ ok }`                                                                   |
| `QUEUE_REMOVE`    | `{ domain, reason, minutes? }`                       | `{ ok, appliedImmediately, applyAt }` — instant if the site is not blocked right now; `minutes` makes it a pass |
| `CANCEL_REMOVE`   | `{ domain }`                                         | `{ ok }` — cancels a wait, or ends an open pass                             |
| `UPDATE_SETTINGS` | `{ blockWindows, frictionDelayMs, reason? }`         | `{ ok, appliedImmediately, applyAt }` — queued if weakening + in window or session |
| `CANCEL_SETTINGS` | —                                                    | `{ ok }`                                                                   |
| `START_FOCUS`     | `{ minutes }`                                        | `{ ok }` — starts a session, or extends a running one; instant             |
| `END_FOCUS`       | `{ reason }`                                         | `{ ok }` — session ends after the friction delay; error if it ends sooner anyway |
| `CANCEL_END_FOCUS`| —                                                    | `{ ok }`                                                                   |
| `SET_FOCUS_ONLY`  | `{ domain, focusOnly }`                              | `{ ok }` — `focusOnly: true` refused while blocking                        |
| `ALLOW_SITE`      | `{ domain }`                                         | `{ ok }` — refused while blocking, or unless `canAllow`                    |
| `REMOVE_ALLOWED`  | `{ domain }`                                         | `{ ok }` — always instant; an open tab on it is redirected during a block  |

---

## Popup and settings page

The popup is for things done during the day; the settings page is for things set up once.
Both only send messages and reflect state: the background enforces every friction rule.
Shared helpers live in `src/ui.ts`.

### `src/popup/popup.ts`

- Header: status dot, and a "Settings" link that calls `chrome.runtime.openOptionsPage()`
- No session: `Focus for [45] min [Start]` row. In a session: a red banner with the time left,
  `+15 min` and `end early` (reason → wait); while an early end waits it shows `ending in` + `cancel`
- Status banner when in a block window (hidden during a session)
- List of blocked sites; focus-only sites carry a quiet `focus only` label (switched on the settings page)
  - Site not blocked right now: ✕ removes instantly
  - Site blocked right now: "Request removal" → intention textarea + "Unblock for N min" → countdown on confirm
    - With a length it is a pass: the site stays on the list, opens after the wait, and is blocked again when the length runs out
    - With the length left empty it is a permanent removal
- Waiting rows show `15 min pass in Xm Ys [cancel]` or `removal in Xm Ys [cancel]`; an open pass shows `open for Xm Ys [end now]`
- Add site input — always instant, even during block window (strengthening change)

### `src/options/options.ts` — settings page

- Header status pill: `Focus session · ends at HH:MM`, `{label} · ends at HH:MM`, or
  `Not blocking · next at HH:MM` (`next Mon 09:00` when not today; from `getNextBlockWindowStart`)
- Pending settings change banner with live countdown and cancel; window and delay controls are
  inert while one waits
- **01 Blocked sites**: per site an `Always` / `Focus only` segmented control (`Focus only` inert while
  blocking), ✕ that removes instantly when the site is not enforced and is inert when it is
  (removal requests and passes stay in the popup), `removal pending` / `pass pending` / `pass open`
  text instead of controls, add box
- **02 Allowed**: each address (emerald mono) with `inside <blocked site>` and a ✕ that is always
  live; add box + "Allow", inert (input disabled, button `aria-disabled` + `title`) while blocking
- **03 Schedule**: week view (bars from `getWeekSegments`; overnight windows in the darker tone,
  split across two days; today emphasised with a now marker), the window list with ✕ (instant
  outside a block, reason → queued inside), and an "Add window" button that reveals label, day
  toggles, start/end — always instant
- **04 Friction**: removal delay input + Save; reducing it during a block asks for a reason and queues
- Re-renders on `chrome.storage.onChanged`, and refreshes the clock-driven parts once a minute

---

## `blocked.html` — Blocked Page

- Full screen, dark background with amber glow
- Show which domain was blocked (passed as `?domain=` query param from DNR redirect)
- Show current block window label and end time (from `chrome.storage.sync`), or "Focus session" and its end time during a session
- Motivational line — dry, not preachy: "You set this up for a reason."
- No bypass controls

---

## `vite.config.ts`

```ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [tailwindcss(), crx({ manifest })],
});
```

---

## `package.json` scripts

```json
{
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^5",
    "@crxjs/vite-plugin": "^2",
    "@types/chrome": "^0",
    "tailwindcss": "^4",
    "@tailwindcss/vite": "^4"
  }
}
```

---

## Loading Into Chrome (dev workflow)

```bash
npm install
npm run dev          # watch mode, rebuilds on save
```

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `dist/` folder
4. Pin the extension to toolbar
5. On code changes → CRXJS hot reloads automatically
6. On `manifest.json` changes → click the reload ↻ button in chrome://extensions

---

## Known Gotchas to Watch For

- **Service worker sleep**: never use setTimeout/setInterval in background.ts. Use chrome.alarms.
- **CRXJS + MV3**: use `@crxjs/vite-plugin@^2` (beta), not v1 — v1 doesn't support MV3 properly.
- **declarativeNetRequest rule IDs**: must be positive integers, no duplicates. Re-generate all IDs on every sync from array index + 1; allow rules number on after the redirect rules.
- **chrome.storage.sync quota**: 8KB per item, 100KB total. Fine for a blocklist, don't store large data.
- **blocked.html must be in web_accessible_resources**: otherwise the redirect silently fails.
- **Extension pages cannot run inline scripts**: popup and `options_page` are manifest HTML entries, so CRXJS bundles their scripts; a page only reached by URL (blocked.html) has to be listed in `build.rollupOptions.input` in `vite.config.ts` to get the same.
- **Popup context vs background context**: popup.ts cannot call chrome.declarativeNetRequest directly in MV3. Always message the background worker.
- **`||domain^` pattern**: this is uBlock/AdBlock filter syntax that Chrome's declarativeNetRequest also supports. It matches `domain.com`, `www.domain.com`, `api.domain.com`, etc. Do not use regex rules — they require extra permissions.
- **blocked page domain param**: DNR redirect uses `extensionPath: '/blocked.html?domain=...'` to pass the blocked domain — `document.referrer` is not reliable here.
