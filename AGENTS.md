# AGENTS.md — Focus Guard Chrome Extension

A Chrome Extension (Manifest V3) site + subdomain blocker with time-based scheduling and
deliberate friction to prevent impulsive disabling. Built with TypeScript + Vite + CRXJS.

---

## Project Goals

- Block domains and all their subdomains
- Time-based blocking windows (user-editable via the popup Schedule tab)
- Friction layer: weakening changes during a block window require deliberate effort, not a single click
- Local only — no server, no auth, no backend
- Clean minimal UI in the popup

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
A countdown is shown in the popup. The user can cancel the queued change within that window.
After the delay, the change applies automatically via `chrome.alarms`.

Why this works: impulse to check social media dies in 10 minutes. Real emergencies don't.

**2. Intention Prompt (secondary)**
Before queuing a delay, the user must type a short reason phrase into a text box.
Example: "I need to check this for work"
The text is never validated — it doesn't need to be. The act of typing it creates
conscious friction and breaks the autopilot loop.

**3. Schedule-Aware UI States**
The popup has two distinct modes:

- **Outside block window**: normal UI, add/remove sites freely, edit schedule freely, no friction
- **Inside block window**: weakening changes (remove site, remove window, reduce delay) require
  intention prompt + delay; strengthening changes (add site, add window, increase delay) are always instant

**4. Friction applies to weakening changes only**
- Removing a blocked site → friction if in block window
- Removing or editing a block window → friction if in block window
- Reducing the friction delay → friction if in block window
- Adding a site → always instant
- Adding a new block window → always instant
- Increasing the friction delay → always instant

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
│   └── popup/
│       ├── popup.html
│       ├── popup.css          — Tailwind entry for popup
│       └── popup.ts
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
> At runtime, all settings are read from storage. Users edit them in the popup Schedule tab.

---

## `src/types.ts`

```ts
export interface PendingRemoval {
  domain: string;
  reason: string;
  scheduledAt: number;
  applyAt: number;
}

export interface PendingSettingsChange {
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  reason: string;
  scheduledAt: number;
  applyAt: number;
}

export interface StorageSchema {
  blockedSites: string[];
  blockWindows: BlockWindow[];
  frictionDelayMs: number;
  pendingRemovals: PendingRemoval[];
  pendingSettingsChange: PendingSettingsChange | null;
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
3. `chrome.runtime.onMessage` — handle popup messages
4. `syncRules()` — rebuild declarativeNetRequest dynamic rules from current blockedSites

### Subdomain Blocking

`declarativeNetRequest` urlFilter syntax `||domain.com^` already matches all subdomains
and the apex domain. No extra work needed — just use that pattern.

### Message API (popup → background)

| type              | payload                                              | returns                                                                    |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET_STATE`       | —                                                    | `{ sites, pendingRemovals, blockWindows, frictionDelayMs, pendingSettingsChange, isBlocking, activeWindow }` |
| `ADD_SITE`        | `{ domain }`                                         | `{ ok }`                                                                   |
| `QUEUE_REMOVE`    | `{ domain, reason }`                                 | `{ ok, appliedImmediately, applyAt }` — instant if outside window          |
| `CANCEL_REMOVE`   | `{ domain }`                                         | `{ ok }`                                                                   |
| `UPDATE_SETTINGS` | `{ blockWindows, frictionDelayMs, reason? }`         | `{ ok, appliedImmediately, applyAt }` — queued if weakening + in window    |
| `CANCEL_SETTINGS` | —                                                    | `{ ok }`                                                                   |

---

## `src/popup/popup.ts` — UI Logic

### Two tabs

**Sites tab**
- Status banner when in a block window
- List of blocked sites
  - Outside block window: ✕ removes instantly
  - Inside block window: "Request removal" → intention textarea → countdown on confirm
- Pending removals show `Xm Ys [cancel]` countdown
- Add site input (hidden during block window)

**Schedule tab**
- List of block windows with ✕ remove buttons
  - Outside block window: instant removal
  - Inside block window: intention textarea → queued
- "Add block window" expandable form: label, day toggles, start/end time — always instant
- Friction delay input (minutes) with Save button
  - Increasing delay: always instant
  - Reducing delay during block window: intention textarea → queued
- Pending settings change banner with live countdown and cancel button

---

## `blocked.html` — Blocked Page

- Full screen, dark background with amber glow
- Show which domain was blocked (passed as `?domain=` query param from DNR redirect)
- Show current block window label and end time (from `chrome.storage.sync`)
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
- **declarativeNetRequest rule IDs**: must be positive integers, no duplicates. Re-generate all IDs on every sync from array index + 1.
- **chrome.storage.sync quota**: 8KB per item, 100KB total. Fine for a blocklist, don't store large data.
- **blocked.html must be in web_accessible_resources**: otherwise the redirect silently fails.
- **Popup context vs background context**: popup.ts cannot call chrome.declarativeNetRequest directly in MV3. Always message the background worker.
- **`||domain^` pattern**: this is uBlock/AdBlock filter syntax that Chrome's declarativeNetRequest also supports. It matches `domain.com`, `www.domain.com`, `api.domain.com`, etc. Do not use regex rules — they require extra permissions.
- **blocked page domain param**: DNR redirect uses `extensionPath: '/blocked.html?domain=...'` to pass the blocked domain — `document.referrer` is not reliable here.
