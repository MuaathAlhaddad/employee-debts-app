# Decisions

A curated, reverse-chronological log of business/architecture decisions and confirmed incidents
for this repo — the "why," not the "what" (git log/diff already has the what). Add a new entry in
the **same commit** as the change that implements it; never let this drift into a later
retroactive catch-up (see `employee-debts-api`'s `KNOWN_ISSUES.md` for what happens when it does).

Each entry: date, decision, why, where it's enforced/relevant in code.

---

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
