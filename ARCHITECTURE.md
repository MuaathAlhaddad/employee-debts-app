# Architecture

This repo is one of three that together run a small shop's debt-tracking and sales system. This
document exists so that fact doesn't depend solely on an external, unversioned link surviving —
see "The three-project system" below for the durable version of what the linked diagram shows.

## This repo's role

`employee-debts-app` is the **employee-facing PWA**: a plain static site (no build step, no npm)
installed on phones so employees can follow up on customer debts and look up product purchase
prices. It holds no data of its own — everything comes from `employee-debts-api` over `fetch()`,
cached locally in IndexedDB (`js/db.js`) so browsing works between syncs. See `CLAUDE.md` for the
file-level breakdown (`index.html` + `css/app.css` + `js/{db,api,app}.js` + `sw.js`).

## The three-project system

```
                    ┌──────────────────────────────┐
                    │   Google Sheet (one file)     │
                    │   opened by ID, not shared    │
                    │   code — two tabs are shared: │
                    │   "Debts Snapshot", "Employees"│
                    └───────┬───────────────┬────────┘
                            │               │
              container-bound              openById() (standalone)
                            │               │
         ┌──────────────────▼───┐   ┌───────▼───────────────┐
         │ pl-report-google-     │   │ employee-debts-api    │
         │ script-v2             │   │ (this repo's backend) │
         │ (OWNER only)          │   │                       │
         │ HtmlService SPA,      │   │ Standalone JSON API,  │
         │ nightly cash/sales    │   │ no HtmlService, no    │
         │ entry + P&L dashboard │   │ Sheet UI of its own   │
         │ + bulk Daftra tools   │   │                       │
         └───────────┬───────────┘   └───────────┬───────────┘
                     │                            │
                     │      both talk to          │ fetch() over
                     └───────────►Daftra◄─────────┘ Content-Type: text/plain
                        (shared account,               │
                         api2/*.json, APIKEY)   ┌───────▼───────────────┐
                                                 │ employee-debts-app     │
                                                 │ (THIS REPO)            │
                                                 │ PWA, IndexedDB cache,  │
                                                 │ service-worker shell   │
                                                 └────────────────────────┘
```

- **Shared Google Sheet**: same file, opened two different ways. `pl-report-google-script-v2` is
  container-bound to it (owner's project). `employee-debts-api` opens the same file by ID
  (`SpreadsheetApp.openById()`), reading/writing only the `Debts Snapshot` and `Employees` tabs.
  The header layout for those two tabs is **duplicated, not shared code**, between the two Apps
  Script projects on purpose — a mismatch should fail loudly, not silently misfile columns.
  Changing either tab's column layout is a cross-repo breaking change requiring both to be updated
  by hand.
- **Shared Daftra account**: both `pl-report-google-script-v2` and `employee-debts-api` call the
  same Daftra account's `api2/*.json` endpoints with their own separately-configured
  `DAFTRA_SUBDOMAIN`/`DAFTRA_API_KEY` Script Properties (not shared between the two Apps Script
  projects, even though the account is the same).
  `employee-debts-app` never talks to Daftra directly — always through `employee-debts-api`.
- **Why `employee-debts-api` is a separate project from `pl-report-google-script-v2`**, per
  `Api.gs`'s header comment: page-size limits in the sales-tracker project's HtmlService IFRAME
  sandbox, and employees shouldn't see the owner's sales/dashboard tabs at all.
- **Deployment models differ per project — do not assume one project's rule applies to another**:
  - `employee-debts-api`: must be deployed to a specific **versioned** deployment id after every
    `clasp push` — `@HEAD` only serves the developer's own Google account regardless of the
    webapp's access setting, so a bare `clasp push` never reaches employees.
  - `pl-report-google-script-v2`: the live URL *is* the `@HEAD` deployment; `npm run watch`
    auto-pushes on every save. That only works because only the owner (who has edit access) ever
    opens it.
  - `employee-debts-app`: no Apps Script deploy step at all — it's static files on GitHub Pages;
    a `git push` to the served branch is the deploy.

## Data flow for a typical action (this repo's side)

1. `js/app.js` calls `apiCall(action, ...params)` (`js/api.js`) — a plain `fetch()` POST to
   `employee-debts-api`'s versioned deployment URL, body `{ action, params }`, sent as
   `Content-Type: text/plain` specifically to avoid a CORS preflight `OPTIONS` request that Apps
   Script Web Apps can't handle.
2. **Reads** (`syncBundle`, product search) are cached in IndexedDB and shown from cache
   immediately when offline; a fresh sync silently updates them when a connection exists.
3. **Financial writes** (payments, invoices) are a fundamentally different case, governed by the
   "Financial writes must be online-only" decision in `DECISIONS.md`. **Part of that decision is
   implemented today, part is not** — see `DECISIONS.md`'s "Current compliance status" for the
   authoritative, itemized breakdown; do not treat the summary below as a substitute for it:
   - **Implemented:** a financial write requires `checkOnline()` (a real timeout-bounded probe,
     not `navigator.onLine`) to confirm reachability before attempting the write; it is never
     served from/queued in any offline cache or outbox; a failed write is shown as a failure
     immediately rather than becoming a pending/retryable transaction.
   - **Not yet implemented:** the balance shown in the post-payment WhatsApp receipt is currently
     computed client-side (an "optimistic" guess) rather than confirmed from the server before
     being shown/sent; there is no idempotency/request-ID protection against a duplicate
     submission if a successful write's response is lost in transit. See `KNOWN_ISSUES.md` for
     both gaps in full.
4. The static app shell (`index.html`/`css`/`js`) is cached by `sw.js`, versioned by
   `CACHE_NAME` — a separate cache from the IndexedDB data cache above, and separate again from
   the *financial-write-must-be-online* rule, which has nothing to do with the shell cache.

## Daftra Client → Notebook Client migration (Owner-only, added 2026-09-08)

`debtCardHtml()` (`js/app.js`) renders one of three states for a Long debtor's card when
`APP.employee.role === "owner"` (that role check only decides whether to show the button — the
API independently re-checks it server-side, see `employee-debts-api`'s `Employees.gs`):
no `d.migration` → "Convert to Notebook Client"; `status: "pending"` → "Notebook client created" +
"View Notebook Client"/"Disable Daftra Client"; `status: "completed"` → "Disabled" + a link to the
Notebook client. `d.migration` comes bundled with every Long debtor from `getDebtsList`/`syncBundle`
already — no extra round trip per card.

Both actions open the same `migrationPanel` overlay (`index.html`, same `.debtSheetOverlay`/
`.debtSheet` pattern as `accountPanel`/`productPanel`) but render deliberately different content —
see `DECISIONS.md`'s 2026-09-08 entry for why these are never combined into one confirmation.
`convertDaftraClientToNotebook`/`disableDaftraClient` are plain `apiCall()`s like any other write
here, followed by a `syncBundle` refresh so the card never shows stale migration state.

## Owner-only Notebook deletion + Notebook tags (added 2026-09-10)

**Deletion** (`initSwipeToDelete_()` and the `confirmDeleteNotebookClient_()`/
`confirmDeleteNotebookTransaction_()` it delegates to, `js/app.js`) covers Notebook (Short) clients
and their individual payment/invoice entries -- never Long (Daftra) debtors, which this feature
doesn't touch. `APP.employee.role === "owner"` gates whether the delete affordance renders at all
(both the swipe wrapper's markup and the "more" menu's Delete button) -- the API independently
re-checks the role server-side (`requireOwnerAccess_()`, `employee-debts-api`'s `Employees.gs`), so
this is a real gate, not just a UI hide. Two entry points render side by side rather than one
replacing the other:
- **Swipe** (mobile-first): a card/row wrapped in `.swipeRow`/`.swipeContent`/`.swipeDeleteBg`
  reveals a red "Delete" button when dragged left past a threshold (Pointer Events, delegated on
  `document` so it survives this app's constant innerHTML re-renders without rebinding). A plain
  tap always falls through to whatever's underneath; only a clearly horizontal drag engages it.
- **An explicit action** (desktop/mouse, since a mouse never fires the drag swipe relies on): the
  card's "more" menu gets a red Delete button; each Short debtor entry in the "Client account"
  panel gets a small 🗑️ icon next to where a Long debtor's entry would show its ✏️ edit icon.

Both paths funnel into the same `confirm()` + `apiCall()` + `doSync()` flow. Deletion is never
optimistic -- nothing is removed from `APP.data` until the server confirms it; a failed request just
snaps the swiped row back closed (the "restore the row on failure" requirement is exactly that,
since the row was never actually removed from view). Same online-only contract as every other write
in this app (`withOnlineCheck()`/`checkOnline()`) -- there's no offline queue to exclude it from
because this app has none for any write.

**Notebook tags:** any logged-in employee can view/filter (a `#debtsTagFilter` chip row, populated
by `renderTagFilterRow_()`, hidden entirely when no tags exist); creating/renaming/assigning/
removing needs edit access (`hasEditAccess()`), matching this feature's server-side gate. A Short
client's own tags render as compact badges under its name (`renderTagBadges_()`) and are
assigned/removed from that card's "more" menu -&gt; Tags (toggleable chips, immediate apply, no
separate save step -- same pattern `toggleReconciliationCard_()` already uses for a different
one-tap toggle). A standalone "Manage tags" panel (`openTagsPanel()`, edit-role only) handles
create/rename at the registry level. `APP.data.tags` comes bundled from `syncBundle()`'s response --
no separate round trip needed for the filter row or the "assign an existing tag" list.

## Where to look next

- `CLAUDE.md` — file-by-file architecture detail and non-obvious gotchas for this repo
  specifically.
- `DECISIONS.md` — dated log of business/architecture decisions and confirmed incidents.
- `KNOWN_ISSUES.md` — open bugs and gaps, including what's already been ruled out.
- `employee-debts-api`'s own `ARCHITECTURE.md`/`DECISIONS.md` — the backend half of this system.
