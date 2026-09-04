# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A plain static PWA (no build step, no `package.json`/npm at all) that employees install on their phones to follow up on customer debts and look up product purchase prices. It's a pure frontend — all data and writes go through `employee-debts-api`, a separate standalone Apps Script project, over `fetch()`. Hosted on GitHub Pages (`github.com/MuaathAlhaddad/employee-debts-app`).

## Running it locally

There's no dev server config in the repo — serve the directory with anything static (e.g. `npx http-server .`) or open `index.html` directly. **If you've tested a previous version on the same phone/browser, clear the service worker and cache first** (DevTools → Application → Service Workers → Unregister, and Clear storage) — `sw.js` aggressively caches the app shell (see below), so a stale install can mask real changes during testing.

## Architecture

- `index.html` + `css/app.css` + `js/{db,api,app}.js` + `sw.js` + `manifest.json`. `js/app.js` is a single large state-driven module (`APP` object at the top holds all UI state); it's organized into clearly commented sections (debtors list/cards, WhatsApp follow-up, sync/actions/toast, the Long/Short debtor account sheet, products view, review log) — check the section header comments before adding a new one rather than guessing where something belongs.
- **Backend calls go through `js/api.js`'s `apiCall(action, ...params)`**, not `google.script.run` (that bridge only exists inside Apps Script-hosted pages; this is a plain fetch from a different origin). Requests are sent as `Content-Type: text/plain` on purpose, so the browser treats it as a CORS "simple request" and skips a preflight `OPTIONS` call that Apps Script Web Apps can't handle — keep that header if you touch this function.
- **`API_URL` in `js/api.js` must be `employee-debts-api`'s versioned deployment, never `@HEAD`** — Apps Script's HEAD deployment only serves the developer's own Google account regardless of the webapp's "Anyone anonymous" setting, so it can't serve employees. If that project gets redeployed to a new version id, this constant has to be updated here by hand; the two repos don't share config.
- **Offline data cache is IndexedDB** (`js/db.js`, plain key-value wrapper), not `localStorage` — the product catalog can get large enough to risk `localStorage`'s ~5MB/synchronous-API limits. This is the *data* cache (debts, products, synced via `syncBundle`); it's separate from the service worker's cache below.
- **`sw.js` caches only the static app shell**, and explicitly lets calls to the API's origin pass through untouched. **`CACHE_NAME`'s version suffix (`employee-debts-shell-v29`) must be bumped on every push that changes `index.html`/`css`/`js`** — it's the only thing that makes an already-installed phone drop its stale cached shell and fetch new files. Forgetting this means an update silently never reaches anyone who already has the app installed (a confirmed real incident, not a theoretical risk). Shell files fetch with `{ cache: "reload" }` at install time specifically to avoid baking in a stale intermediate-cache response permanently.
- `checkOnline()` in `js/api.js` does a real short-timeout probe against the API before allowing a write action — `navigator.onLine` alone is unreliable (it only means "has a network interface," not "can actually reach the internet").

## Working across repos

This app, `employee-debts-api`, and the owner-facing `pl-report-google-script-v2` sales-tracker together read/write one shared Google Sheet (via the API project) and one shared Daftra account. When a change here depends on a new/changed API action, it needs a corresponding change in `employee-debts-api`'s `Api.gs` (`API_ACTIONS` whitelist) deployed to the versioned deployment `API_URL` points at — a frontend change alone won't do anything until that lands.
