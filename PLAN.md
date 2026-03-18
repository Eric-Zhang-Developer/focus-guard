# Focus Guard MLP Plan

## Goal

Ship a solid minimum lovable product for a Chrome extension that blocks configured domains and subdomains, enforces hardcoded focus windows, and adds deliberate friction to removal during active blocks.

## Product Standard

The MLP is successful when:

- blocked domains and subdomains reliably redirect during active focus windows
- the popup feels simple and dependable
- bypassing is possible but slow enough to kill impulsive behavior
- schedule changes require editing code, rebuilding, and reloading the extension
- the extension survives MV3 service worker sleep without losing core behavior

## Phase 0: Foundation And Constraints

### Outcome

Set up the project so the extension can build, load in Chrome, and support MV3 correctly.

### Work

- create `package.json` with `vite`, `typescript`, `@crxjs/vite-plugin`, and `@types/chrome`
- create `tsconfig.json` with strict TypeScript settings
- create `vite.config.ts` using CRXJS
- add `manifest.json` with MV3 permissions, popup, background worker, DNR resources, and `web_accessible_resources`
- add `rules.json` as an empty array
- add placeholder icons in `icons/`

### Exit Criteria

- `npm install` succeeds
- `npm run build` produces a valid `dist/`
- the unpacked extension loads in `chrome://extensions` without manifest errors

## Phase 1: Shared Models And Hardcoded Schedule

### Outcome

Define the core data model and make the schedule intentionally code-driven.

### Work

- create `src/types.ts` for storage and pending removal types
- create `src/config.ts` with block windows and friction delay
- keep schedule editing out of the UI by design
- document that `config.ts` is the only place to change focus windows

### Exit Criteria

- schedule structure is typed and easy to modify in code
- pending removal data is represented cleanly for storage and UI

## Phase 2: Background Worker Core

### Outcome

Build the extension’s reliable control plane in the service worker.

### Work

- initialize storage on install
- implement `isInBlockWindow()`
- implement `syncRules()` to regenerate dynamic DNR rules from `blockedSites`
- create a minute alarm with `chrome.alarms`
- apply pending removals when `applyAt` has passed
- implement popup message handlers:
  - `GET_STATE`
  - `ADD_SITE`
  - `QUEUE_REMOVE`
  - `CANCEL_REMOVE`
  - internal apply flow for pending removals
- store enough state for popup and blocked page messaging

### Exit Criteria

- adding a site updates dynamic rules
- subdomains are covered through `||domain^`
- pending removals survive popup closure and service worker sleep
- no background logic depends on timers like `setTimeout` or `setInterval`

## Phase 3: Blocked Page

### Outcome

Show a simple, intentional blocked experience instead of a broken redirect.

### Work

- create `blocked.html`
- show blocked domain if available
- show active block window label and end time
- keep the message dry and minimal
- avoid any bypass controls on the page

### Exit Criteria

- blocked navigations land on `blocked.html`
- the page clearly explains why the site is blocked and when the block ends

## Phase 4: Popup MVP

### Outcome

Deliver the basic management UI outside block windows.

### Work

- create `src/popup/popup.html`
- create `src/popup/popup.css`
- create `src/popup/popup.ts`
- fetch state from the background on open
- add domain input with sanitization:
  - strip protocol
  - strip `www.`
  - strip paths and trailing slashes
  - reject invalid values
- render blocked sites list
- allow instant add/remove outside active windows
- show next focus window timing if available

### Exit Criteria

- users can add a valid domain in a few seconds
- invalid input gets a clear inline error
- remove works instantly when outside a focus window

## Phase 5: Friction Layer

### Outcome

Turn the popup from a normal blocker UI into a behavior-shaping one during active windows.

### Work

- switch popup into locked mode during active block windows
- make the blocked sites list effectively read-only except for removal requests
- replace instant removal with:
  - intention prompt textarea
  - queue action with `FRICTION_DELAY_MS`
  - visible countdown
  - cancel option
- hide add controls during active windows
- show a small note that the schedule lives in `config.ts`
- show current active window label and end time prominently

### Exit Criteria

- removing a site during a block window requires typing a reason
- queued removals do not apply immediately
- countdown reflects the actual `applyAt` time from storage
- cancel works before the delay expires

## Phase 6: End-To-End Validation

### Outcome

Prove the core user promise works in Chrome.

### Manual Test Pass

1. build the extension and load `dist/` unpacked
2. add `reddit.com` outside a block window
3. verify `reddit.com` redirects to `blocked.html` during a block window
4. verify `old.reddit.com` is also blocked
5. verify removal is instant outside a block window
6. verify removal during a block window requires a typed reason and enters pending state
7. verify the removal applies after the 10 minute delay
8. verify canceling a pending removal keeps the site blocked
9. close and reopen Chrome or let the worker sleep, then confirm pending removals still apply

### Exit Criteria

- core blocking works on both apex domains and subdomains
- friction behavior matches the intended design
- state persists across popup closes and service worker sleep

## Phase 7: Polish For MLP

### Outcome

Tighten the product so it feels intentional instead of merely functional.

### Work

- improve popup copy and empty states
- make spacing and typography clean and compact
- ensure the blocked page and popup look consistent
- add small guardrails for duplicate domains and duplicate pending removals
- verify failure paths show useful messages instead of silently failing

### Exit Criteria

- the extension feels stable and understandable without extra explanation
- there are no obvious edge-case footguns in normal usage

## MLP Scope Boundary

Keep these out of the first solid release unless something core is already broken:

- editable schedules in the UI
- pause-all mode
- import/export
- analytics
- cloud sync beyond `chrome.storage.sync`
- category presets
- password locks
- cross-browser support beyond Chrome

## Recommended Build Sequence

1. scaffolding and manifest
2. shared types and config
3. background worker and DNR syncing
4. blocked page
5. popup free mode
6. popup locked mode and friction
7. manual end-to-end testing
8. polish and bug fixes

## Definition Of Done

The MLP is done when a user can install the extension, add distracting domains, get redirected during focus windows, and still technically bypass the block only by waiting through a deliberate removal delay with enough friction to interrupt impulsive behavior.
