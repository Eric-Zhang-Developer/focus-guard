# Focus Guard

**Block distracting sites with built-in friction.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat&logo=vitest&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-MV3-4285F4?style=flat&logo=googlechrome&logoColor=white)

---

## Overview

Focus Guard is a personal Chrome extension that blocks distracting websites on a configurable schedule, or on demand with a focus session. When a block window or focus session is active, blocked sites redirect to a custom page. The key feature is the **friction system**: removing a site or weakening settings during a block window requires you to type a reason and wait through a countdown delay — making impulsive bypassing harder and more deliberate.

---

## How It Works

1. **Add sites to block** via the popup (Sites tab)
2. **Configure block windows** — set which days and time ranges should be enforced (Schedule tab)
3. **Start a focus session** ("Focus for 45 min") to block on demand. Sites flagged *focus only* are blocked only in sessions, not in scheduled windows
4. **Blocked sites redirect** to the blocked page during active windows and sessions
5. **Unblocking a site, ending a session early, or weakening settings during a block window or session** requires a typed reason and a countdown delay before the change takes effect. A site can be unblocked for a set number of minutes (a pass) and is blocked again afterwards, or removed for good
6. **Pending changes apply automatically** via a background alarm; the popup shows live countdowns

---

## Key Features

- Scheduled block windows (configurable days and time ranges)
- Focus sessions — block now for N minutes; extending is instant, ending early costs a reason + wait
- Per-site "focus only" flag — blocked in focus sessions only, reachable in scheduled windows
- Friction-based site removal — reason prompt + countdown, not just a click
- Timed passes — unblock a site for a chosen number of minutes; it re-blocks itself
- Protected settings — weakening during a block window requires friction
- Pending change queue with live countdown timers in the popup
- Blocked page shows which site was intercepted
- Settings sync across sessions via `chrome.storage.sync`
- Manifest V3 (service worker, `declarativeNetRequest`)

---

## Tech Stack

### Extension

| Tool | Purpose |
|------|---------|
| TypeScript | Type-safe source |
| Vite + `@crxjs/vite-plugin` | Build and extension bundling |
| Tailwind CSS v4 | Popup styling |
| Chrome MV3 APIs | `declarativeNetRequest`, `storage.sync`, `alarms` |

### Testing

| Tool | Purpose |
|------|---------|
| Vitest | Unit tests for core business logic |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Google Chrome

### Install

```bash
npm install
```

### Load the extension

1. Run a build:
   ```bash
   npm run dev   # or npm run build
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `dist/` folder

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch build (auto-rebuilds on file change) |
| `npm run build` | Production build |
| `npm test` | Run tests |
