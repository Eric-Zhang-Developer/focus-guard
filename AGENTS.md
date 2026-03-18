# AGENTS.md — Focus Guard Chrome Extension

A Chrome Extension (Manifest V3) site + subdomain blocker with time-based scheduling and
deliberate friction to prevent impulsive disabling. Built with TypeScript + Vite + CRXJS.

---

## Project Goals

- Block domains and all their subdomains
- Time-based blocking windows (hardcoded schedule in a config file)
- Friction layer: disabling the extension or removing a site during a block window requires
  deliberate effort, not a single click
- Local only — no server, no auth, no backend
- Clean minimal UI in the popup

---

## Friction Design (read this carefully before building)

The user wants it to be _possible_ but _annoying_ to bypass. The goal is to create
enough resistance to kill impulsive disabling, while not being so locked down that
it causes genuine frustration in a real emergency.

### Chosen Friction Mechanisms

**1. Commitment Delay (primary)**
When the user tries to remove a site or pause blocking during an active block window,
the change is not applied immediately. Instead it is queued with a 10-minute delay.
A countdown is shown in the popup. The user can cancel the queued change within that window.
After 10 minutes, the change applies automatically.

Why this works: impulse to check social media dies in 10 minutes. Real emergencies don't.

**2. Intention Prompt (secondary)**
Before queuing a delay, the user must type a short reason phrase into a text box.
Example: "I need to check this for work"
The text is never validated — it doesn't need to be. The act of typing it creates
conscious friction and breaks the autopilot loop.

**3. Schedule-Aware UI States**
The popup has two distinct modes:

- **Outside block window**: normal UI, add/remove sites freely, no friction
- **Inside block window**: read-only list, remove requires intention prompt + delay,
  no pause button visible, a motivational message is shown instead

**4. Hardcoded Schedule = No UI to Toggle It**
The schedule lives in `src/config.ts`. There is no UI to change it in the popup.
To change the schedule the user must edit code and rebuild. This is intentional.
Document this clearly in the popup ("Schedule is set in config.ts").

---

## Tech Stack

```
TypeScript (strict)
Vite + @crxjs/vite-plugin     — build + hot reload
Tailwind CSS v4 (PostCSS)      — utility classes in popup.html, no separate popup.css needed
Chrome Extension Manifest V3
declarativeNetRequest API      — network-level blocking (efficient, no page injection needed)
chrome.storage.sync            — persists blocklist + pending changes across devices
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
│   ├── config.ts              — hardcoded block schedule + settings
│   ├── types.ts               — shared TypeScript types
│   └── popup/
│       ├── popup.html
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

## `src/config.ts` — Hardcoded Schedule

```ts
export interface BlockWindow {
  label: string;
  days: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  startHour: number; // 0-23
  startMin: number;
  endHour: number;
  endMin: number;
}

export const BLOCK_WINDOWS: BlockWindow[] = [
  {
    label: "Deep Work Morning",
    days: [1, 2, 3, 4, 5], // Mon–Fri
    startHour: 9,
    startMin: 0,
    endHour: 12,
    endMin: 0,
  },
  {
    label: "Afternoon Focus",
    days: [1, 2, 3, 4, 5],
    startHour: 14,
    startMin: 0,
    endHour: 17,
    endMin: 0,
  },
];

// How long (ms) to delay a removal request during a block window
export const FRICTION_DELAY_MS = 10 * 60 * 1000; // 10 minutes
```

> **To change your schedule**: edit this file and run `npm run build`, then reload the
> extension in chrome://extensions. There is no UI for this on purpose.

---

## `src/types.ts`

```ts
export interface PendingRemoval {
  domain: string;
  reason: string;
  scheduledAt: number; // Date.now() when queued
  applyAt: number; // scheduledAt + FRICTION_DELAY_MS
}

export interface StorageSchema {
  blockedSites: string[];
  pendingRemovals: PendingRemoval[];
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

1. On install: initialise storage, set up alarms, sync rules
2. `chrome.alarms.onAlarm` — every minute: check pending removals, apply if delay elapsed
3. `chrome.runtime.onMessage` — handle popup messages (add, queue-remove, cancel-remove, get-state)
4. `syncRules()` — rebuild declarativeNetRequest dynamic rules from current blockedSites

### Subdomain Blocking

`declarativeNetRequest` urlFilter syntax `||domain.com^` already matches all subdomains
and the apex domain. No extra work needed — just use that pattern.

### syncRules() logic

```
1. get current dynamic rules → extract IDs
2. get blockedSites from storage
3. map each domain to a rule:
   {
     id: index + 1,
     priority: 1,
     action: { type: REDIRECT, redirect: { extensionPath: '/blocked.html' } },
     condition: {
       urlFilter: `||${domain}^`,
       resourceTypes: [MAIN_FRAME]
     }
   }
4. updateDynamicRules({ removeRuleIds, addRules })
```

### isInBlockWindow() helper

```ts
function isInBlockWindow(): boolean {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  const min = now.getMinutes();
  const totalMin = hour * 60 + min;

  return BLOCK_WINDOWS.some(
    (w) =>
      w.days.includes(day) &&
      totalMin >= w.startHour * 60 + w.startMin &&
      totalMin < w.endHour * 60 + w.endMin,
  );
}
```

### Message API (popup → background)

| type            | payload              | returns                                                                    |
| --------------- | -------------------- | -------------------------------------------------------------------------- |
| `GET_STATE`     | —                    | `{ sites, pendingRemovals, isBlocking, activeWindow }`                     |
| `ADD_SITE`      | `{ domain }`         | `{ ok }`                                                                   |
| `QUEUE_REMOVE`  | `{ domain, reason }` | `{ applyAt }` — queues with delay if in window, applies immediately if not |
| `CANCEL_REMOVE` | `{ domain }`         | `{ ok }`                                                                   |
| `APPLY_PENDING` | —                    | internal, called by alarm handler                                          |

---

## `src/popup/popup.ts` — UI Logic

### Two UI modes based on `isBlocking` from GET_STATE

**Mode A — Free (outside block window)**

- Input to add a new domain
- List of blocked sites, each with an ✕ remove button (instant, no friction)
- Footer shows next block window start time

**Mode B — Locked (inside block window)**

- Header banner: "🔴 Focus time — [window label]" with end time
- List of blocked sites, read-only
- Each site has a "Request removal" button instead of ✕
  - Clicking opens an inline form: textarea "Why do you need this?" + confirm button
  - On submit: sends QUEUE_REMOVE, shows countdown timer on that row
  - Countdown ticks down live using setInterval (fine in popup, popup stays alive while open)
- Pending removals show "[domain] — unblocking in 8m 32s [cancel]"
- No add button (can't add during block window either — keep it simple)
- Small grey note: "Schedule is set in config.ts"

### Domain input sanitisation (for add)

Strip `https://`, `http://`, `www.`, trailing slashes, paths.
Validate it looks like a domain (contains a dot, no spaces).
Show inline error if invalid.

---

## `blocked.html` — Blocked Page

- Full screen, dark background
- Show which domain was blocked (parse from `window.location` or referrer)
- Show current block window label and end time (read from `chrome.storage.sync`)
- Motivational line — keep it dry, not preachy
- No "go back" or override button — they can close the tab

Example copy:

```
🛑 reddit.com
Deep Work Morning · ends at 12:00
You set this up for a reason.
```

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

## Build Order for Claude Code

Implement in this order to keep things testable at each step:

1. `package.json` + `vite.config.ts` + `tsconfig.json` — scaffolding
2. `manifest.json` + `rules.json` (empty array) + placeholder icons
3. `src/types.ts` + `src/config.ts`
4. `src/background.ts` — full implementation including syncRules + alarm + message handler
5. `blocked.html` — static blocked page
6. `src/popup/popup.html` + `popup.css` + `popup.ts`
7. End-to-end test: add reddit.com, verify it redirects to blocked.html, verify subdomain old.reddit.com also blocked

---

## Known Gotchas to Watch For

- **Service worker sleep**: never use setTimeout/setInterval in background.ts. Use chrome.alarms.
- **CRXJS + MV3**: use `@crxjs/vite-plugin@^2` (beta), not v1 — v1 doesn't support MV3 properly.
- **declarativeNetRequest rule IDs**: must be positive integers, no duplicates. Re-generate all IDs on every sync from array index + 1.
- **chrome.storage.sync quota**: 8KB per item, 100KB total. Fine for a blocklist, don't store large data.
- **blocked.html must be in web_accessible_resources**: otherwise the redirect silently fails.
- **Popup context vs background context**: popup.ts cannot call chrome.declarativeNetRequest directly in MV3. Always message the background worker.
- **`||domain^` pattern**: this is uBlock/AdBlock filter syntax that Chrome's declarativeNetRequest also supports. It matches `domain.com`, `www.domain.com`, `api.domain.com`, etc. Do not use regex rules — they require extra permissions.
