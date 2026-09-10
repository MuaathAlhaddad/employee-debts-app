# Decisions

A curated, reverse-chronological log of business/architecture decisions and confirmed incidents
for this repo — the "why," not the "what" (git log/diff already has the what). Add a new entry in
the **same commit** as the change that implements it; never let this drift into a later
retroactive catch-up (see `employee-debts-api`'s `KNOWN_ISSUES.md` for what happens when it does).

Each entry: date, decision, why, where it's enforced/relevant in code.

---

## 2026-09-10 — Notebook swipe-to-delete: never optimistic, and paired with an equivalent explicit action for desktop

**Decision:** Swiping a Notebook client card (or a Short debtor's payment/invoice entry inside its
"Client account" panel) left past a threshold reveals a red Delete button (`initSwipeToDelete_()`,
`js/app.js`) — tapping it still requires a `confirm()` before anything is sent. The row is **never**
removed from `APP.data`/the DOM before the server confirms the delete; a failed request just snaps
the row back closed. Every place that renders the swipe gesture also renders an equivalent explicit
button (the card's "more" menu Delete button; a small 🗑️ icon on each Short debtor account-statement
entry) — swipe is additive for mobile, not the only way in, since a mouse never fires the drag it
relies on.

**Why:** Direct requirements from this feature's spec: "do not delete immediately on swipe,"
"restore the row if the API fails," "prevent accidental/double deletion," and "for desktop, use an
appropriate contextual/overflow action." A `confirm()` dialog plus a disabled-while-in-flight button
(`swipeDeletingIds_`, a Set of ids currently mid-delete) covers accidental/double deletion the same
way `submitDisable()`'s existing `btn.disabled = true` pattern already does for the migration
feature's own destructive action.

**How to apply:** Any future swipe-to-delete surface in this app should follow the same shape:
Pointer Events delegated on `document` (survives this app's constant innerHTML re-renders without
per-row rebinding), a real `confirm()`, no optimistic removal, and a non-swipe fallback action
alongside it — don't make swipe the *only* way to trigger a destructive action.

## 2026-09-10 — Notebook deletion is owner-only in the UI; Notebook tags are edit-role, not owner-only

**Decision:** The delete affordance (both the swipe wrapper and the "more" menu button) only renders
when `APP.employee.role === "owner"` — a bare role check, not `hasEditAccess()`, since an edit-role
(non-owner) employee must never see it at all. Notebook tag viewing/filtering is
open to every logged-in employee; creating/renaming/assigning/removing a tag uses `hasEditAccess()`,
the same gate every other edit-capable action in this app uses.

**Why:** Matches the server-side authorization exactly (`requireOwnerAccess_()` vs.
`requireEditAccess_()`, `employee-debts-api`'s `Employees.gs`/`Tags.gs`) — the frontend's role check
only decides whether to render the button; the API independently re-checks and would reject either
action for the wrong role regardless of what the UI shows. Keeping the two in sync avoids the exact
regression `DECISIONS.md`'s 2026-09-09 "`hasEditAccess()`" entry describes for a different feature —
a UI gate that's stricter or looser than the server's.

**How to apply:** Don't loosen the delete affordance's role check to `hasEditAccess()` "for
convenience" — deletion is deliberately owner-only, unlike almost everything else in this app.

---

## 2026-09-09 — Phone number inputs strip whitespace live, not just on submit

**Decision:** The phone `<input>`s (`newPhone` in `index.html`, `editPhone-${clientId}` in `js/app.js`'s `editShort` action) now strip whitespace on every `input` event (`oninput="this.value = this.value.replace(/\s+/g, '')"`), and `submitShortDebt()`/`submitEditShort()` also strip whitespace when reading the value as a defensive backstop.

**Why:** Pasting a phone number (e.g. from Contacts, WhatsApp, or a spreadsheet) commonly carries spaces (`+966 50 123 4567`), which previously passed straight through to the sheet/WhatsApp deep link unchanged. `normalizePhoneForWhatsapp_()` already strips non-digits for the WhatsApp link, but the *stored* phone value (what's shown on the card and saved to the Sheet) kept the spaces.

**How to apply:** Any new free-text phone field should follow the same pattern — live-strip on input plus a defensive strip at read time — rather than relying on `.trim()` alone, which only removes leading/trailing whitespace.

## 2026-09-09 — Every edit-gated UI element must use `hasEditAccess()`, not a bare `role === "edit"` check

**Decision:** `js/app.js` now has `hasEditAccess()` (`role === "edit" || role === "owner"`), used everywhere an edit-role action's button/section visibility is decided (the "+" add button, the Outstanding total, "Refresh from Daftra", the review log button, and every card's `canEdit` in `debtCardHtml`/`renderAccountSheet`/`renderDebtorsList`).

**Why:** Confirmed as a real regression the day after the "owner" role was added (`employee-debts-api`'s `Employees.gs`, 2026-09-08): the backend's `requireEditAccess_()` was updated to treat `"owner"` as a superset of `"edit"`, but the frontend's checks were all still a bare `role === "edit"` — so the Owner could no longer add a payment/invoice, add a Notebook client, or see the Outstanding total, even though the API would have allowed all of it. The API was never wrong; only the frontend's gating was out of sync with it.

**How to apply:** Any new edit-gated UI element must call `hasEditAccess()`, not check `.role` directly. The Owner-only migration buttons (`d.migration`-driven) are a deliberate exception — those stay `role === "owner"` exclusively, since edit-role employees must NOT see them.

## 2026-09-08 — `escapeAttr()` alone is not safe inside an inline event handler's JS string; use `escapeJsAttr()`

**Decision:** Any free-text value (a client/product name — anything not a system-generated id)
interpolated into a single-quoted JS argument *inside* an inline handler attribute, e.g.
`onclick="fn('${value}')"`, must go through the new `escapeJsAttr()` (`js/app.js`), not
`escapeAttr()` alone.

**Why:** Confirmed by an automated security review of this session's commits (2026-09-08):
`escapeAttr()` only guards the *outer* HTML attribute boundary (escapes `"`) — it does nothing for
`'` or `\`, which is what actually terminates the *inner* JS string literal in an `onclick="fn('...')"`
handler. A name containing a single apostrophe already breaks the handler; a name containing
`x'); alert(1); //` runs arbitrary JS the moment the card renders. This pattern existed in this
codebase before this session (`openProductHistory`'s product-name argument) and was introduced
again in this session's own new code (`viewNotebookClient` calls) before being caught — both are
now fixed with `escapeJsAttr()`, along with `accountOnclick`'s client name.

**How to apply:** `escapeJsAttr()` = escape `\` and `'` for the JS-string context first, then
`escapeAttr()` for the HTML-attribute context around it. Use it for every free-text value that
ends up inside a single-quoted argument in an inline event handler; `escapeAttr()` alone stays
correct for a free-text value in an ordinary HTML attribute (e.g. an `<input value="...">`), which
isn't also JS.

## 2026-09-08 — Daftra Client → Notebook Client migration: two separate panels/confirmations, never combined

**Decision:** The Owner-only migration workflow (`openConvertModal`/`submitConvert` and
`openDisableModal`/`submitDisable` in `js/app.js`) is rendered as two visually and functionally
distinct steps, sharing one overlay (`migrationPanel` in `index.html`) but never one combined
confirmation:
- **Step 1 ("Convert to Notebook Client")** is framed as safe/non-destructive — plain buttons,
  no `confirm()`, explicit text stating the Daftra client is NOT being disabled yet.
- **Step 2 ("Disable Daftra Client")** only appears on the card once step 1 has succeeded for that
  client (`d.migration` present, from the server), is styled with the danger color
  (`.debtBtnDanger`/`.migrationInfoBox-danger`), and requires both a typed new name AND a
  `confirm()` dialog before submitting.

**Why:** Direct requirement of the migration feature spec (2026-09-08) — the two steps have
completely different blast radii (one creates an independent new record; the other clears a real
Daftra balance and renames/suspends a real client) and must never be collapsible into a single tap.

**How to apply:** If this workflow is ever redesigned, keep the two steps as separately-confirmed
actions. Don't add a "convert and disable in one click" shortcut, even for convenience — the
whole point is that the Owner looks at the new Notebook client before the Daftra client is touched.

## 2026-09-05 — Financial writes must be online-only; no offline queueing

**Decision:** The PWA remains offline-capable for **reads** only. Financial **writes** —
at minimum: adding a customer payment, creating an invoice, or any other operation that creates
or modifies a financial transaction in Daftra — must never be queued for later offline
synchronization, and must never be treated as successful before the server confirms it.

Required behavior:
1. Before attempting a financial write, require an actual, freshly-verified connection to the
   backend — `navigator.onLine` alone is **not** proof the backend/Daftra is reachable (it only
   means "has a network interface").
2. The operation counts as successful **only** after the server confirms the write actually
   succeeded (not merely that the HTTP request completed).
3. After a successful payment, the server must return, or the client must retrieve, the
   **authoritative** updated customer balance — not a locally-guessed one.
4. Only after that confirmed success may the PWA show the success/receipt UI and offer to send
   the receipt and remaining balance via WhatsApp. The balance in that message must be the
   confirmed one, not an optimistic client-side calculation.
5. A failed write is shown as a failure immediately — never silently retried, never softened.
6. Failed financial writes are **never** placed in an offline/outbox queue for later retry. If
   this repo ever grows a general offline write-queue for some other feature, financial writes
   must be explicitly excluded from it.
7. Financial writes must be protected against duplicate submission via an idempotency/request ID
   where appropriate — specifically to cover the case where Daftra applies the write successfully
   but the confirmation response is lost before reaching the PWA (flaky mobile network), and the
   employee is tempted to just tap the button again.

**Why:** The employee needs the correct, confirmed customer balance immediately after a payment
in order to send an accurate receipt/remaining-balance message over WhatsApp — sending a wrong
number in that message is worse than making the employee wait a moment for a real answer. This
also minimizes the risk of financial data loss (a "successful-looking" write that Daftra never
actually received) and gives the employee an immediate, trustworthy signal of whether the
transaction really went through.

**Current compliance status — the authoritative, itemized answer to "is this decision actually
implemented yet." `ARCHITECTURE.md` and `KNOWN_ISSUES.md` both summarize this; if either ever
looks out of sync with the list below, this entry wins.**

**IMPLEMENTED (verified against the current code, 2026-09-05):**
- Financial writes require actual, freshly-verified backend availability: `checkOnline()`
  (`js/api.js`) does a real timeout-bounded probe, not a `navigator.onLine` check, and every
  financial-write path (`submitPayment`, `submitInvoice`, `submitAccountPayment`,
  `submitEditEntry`, `submitShortDebt`, `submitEditShort`) routes through it via
  `withOnlineCheck()` before attempting the write.
- Financial writes are not queued for later retry: there is no offline write-queue/outbox
  anywhere in this codebase today. This decision formalizes that absence as intentional, not an
  oversight — don't add one for financial writes.
- A failed financial write fails immediately rather than becoming a pending transaction: every
  write path's `.catch()` shows the error immediately; none silently retry or hold a failed write
  in any kind of pending state.

**NOT YET IMPLEMENTED (requirements 3 and 7 above — do not treat these as done):**
- **Authoritative balance confirmed before the final success/WhatsApp receipt.**
  `submitPayment`/`submitInvoice`/`submitAccountPayment` currently build the WhatsApp message from
  a **locally-computed "optimistic" balance**
  (`d.amount - d.amountPaid - Number(amount)` / `APP.activeAccount.balance - Number(amount)`),
  shown/sent *before* the follow-up `doSync()`/`syncBundle` call confirms the real balance from
  the server. `submitAccountPayment`'s own code comment literally calls this "optimistic new
  balance." This directly violates requirement 4 above and needs to change so the confirmed
  balance (ideally returned directly by the write action itself, not a second round-trip) is what
  gets shown and sent.
- **Idempotency/request-ID protection against duplicate submission.** No mechanism exists on any
  financial write action, client or server side (requirement 7), to protect against the case
  where Daftra applies a write successfully but the response is lost before reaching the PWA.
  Needs design work on the `employee-debts-api` side first — whether Daftra's own API supports a
  client-supplied reference/idempotency field is UNVERIFIED as of 2026-09-05.

---

## 2026-08-28 — Restore Add Payment/Add invoice for Daftra (Long) debtors

**Decision:** Both Long and Short debtors get the same three card actions (Client account, Add
Payment, Add invoice) again. Reverses the very next day's worth of the 2026-08-27 removal below.

**Why:** Owner's request, 2026-08-28 — no recorded reason for the reversal beyond "wanted them
back"; the 2026-08-27 rationale (real Daftra money actions should only happen through the account
panel) did not hold up in practice for a full day.

**How to apply:** If a future request suggests removing these actions again "to simplify," check
with the owner first — this was tried once already and reverted within a day.

## 2026-08-27 — (superseded same week) Remove Add Payment/Add invoice for Daftra debtors

**Decision:** Long debtors only get "Client account" on their card; Add Payment/Add invoice
removed for them (Short debtors unaffected). **Superseded 2026-08-28, see above — do not
reintroduce this without checking with the owner first.**

**Why:** Owner's request — real Daftra money actions should only go through the account panel's
own payment flow, not the local-tracking-style shortcuts. Reversed the next day.

---

## 2026-08-26 — Numeric SKU must be coerced to string before searching

**Decision:** Product search always `String()`-coerces `name`/`sku` before comparing, both here
(defense in depth) and at the source in `employee-debts-api`.

**Why:** A Sheets-cell-sourced SKU that looks numeric (e.g. `"2038"`) can come back from the API
as an actual JS number, and calling `.toLowerCase()` on a number threw, silently killing the
*entire* product search with no visible error (confirmed 2026-08-26).

**How to apply:** Any new field read from a synced Sheet row that gets `.toLowerCase()`d or
similarly string-manipulated needs the same defensive coercion.

## 2026-08-25 — Service worker cache must be versioned on every shell-affecting push

**Decision:** `sw.js`'s `CACHE_NAME` suffix must be bumped on every push that changes
`index.html`/`css`/`js`.

**Why:** This is the *only* mechanism that makes an already-installed phone drop its stale cached
app shell and fetch new files — forgetting it means an update silently never reaches anyone who
already has the app installed. Confirmed as a real incident, not a theoretical risk.

## 2026-08-24 → 2026-08-26 — Account statement windowing changed after ship (git history is stale here)

**Decision (current, as of 2026-08-26):** The Long Debtor "Client account" statement shows the 5
most recent entries, bounded by fetching only the last 2 pages of each Daftra list endpoint — not
a calendar-day window.

**Why this note exists:** This repo's own commit `5c676e2` (2026-08-24) is titled "...scope
account statement to last 30 days" and describes a **date-based** 30-day window. The current
implementation of that feature does not live in this repo at all, though — the actual windowing
logic (`fetchDaftraRecentEntries_()`) is server-side, in **`employee-debts-api`'s `Daftra.gs`**,
and its in-code comment there says the owner asked for record-count-based recency instead the
following day (2026-08-26). **Do not read `5c676e2`'s message as a description of current
behavior** — read `employee-debts-api`'s code/comment instead. This entry exists specifically to
prevent that mistake recurring.

**UNVERIFIED:** exactly how and when the 2026-08-26 change reached production. No git commit
describing it exists in either this repo or `employee-debts-api` (confirmed via `git log` in both,
2026-09-05) — the only surviving record is the in-code comment in `employee-debts-api`'s
`Daftra.gs`. Whether it went out via `clasp push`/`clasp deploy` specifically, or some other route,
and the exact date it went live, cannot be confirmed from the repos alone. See
`employee-debts-api`'s `KNOWN_ISSUES.md` for the related, better-evidenced incident (commit
`4d77bde`) where an explicit commit message *does* confirm changes shipped via `clasp` before
being committed — this entry is a weaker, comment-only version of the same pattern, not an
independently confirmed instance of it.

## 2026-08-27 — Outstanding total is edit-role only

**Decision:** The shop-wide "Outstanding" total is hidden from view-only employees; individual
debtor balances remain visible to everyone.

**Why:** Owner's request, 2026-08-27 — no finer-grained reason recorded.

## 2026-08-29 — "Needs reconciliation" is a manual-only flag, and always will be

**Decision:** A Long debtor's balance can be flagged "needs reconciliation" only by an edit-role
employee tapping a button — there is no automatic detection.

**Why:** A client's Daftra balance can move via a manual Journal Entry, which this system
deliberately does not account for (`journals.json` entries key off an internal
`journal_account_id`, not `client_id`, and the account has 40,000+ of them — not practical to
cross-reference). This is a permanent architectural gap, not unfinished work; don't attempt to
"finish" auto-detection without first re-confirming Daftra's API still offers no better hook.

## 2026-09-01 / 2026-09-02 — Short debtors get a real transaction ledger; stay "active" at zero balance

**Decision:** Short (Notebook) debtors have a proper one-row-per-event ledger (Short Debtor
Transactions), matching the Long debtor account-statement UX. A Short debtor paid down to zero no
longer auto-closes to "paid" status.

**Why:** Owner's request — a paid-off Short debtor disappearing from the Active list made it
harder to spot a repeat debtor and add new debt to their existing record. Marking fully paid stays
a deliberate, separate action.
