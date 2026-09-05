# Known Issues

Open bugs, gaps, and in-progress investigations that don't belong in `DECISIONS.md` (which is for
settled decisions) but that a future session needs to know about rather than rediscover from
scratch. Update the relevant entry (status, what's been ruled out, what's still unverified) at the
end of any session that touches one of these without fully resolving it — don't let an
investigation's findings live only in chat history.

---

## OPEN — Long debtor card doesn't reflect a payment/invoice until "Refresh from Daftra"

**Symptom:** After adding a payment/invoice to a Daftra (Long) debtor through the PWA's own
"Add Payment"/"Add invoice" buttons, the debtor's card balance doesn't update. Making a *second*
change to the same debtor then shows *both* changes applied at once. The full, slow "Refresh from
Daftra" button (a completely different code path — a full account rescan) does show the correct
number.

**Status as of 2026-09-05:** Not yet fixed. Investigated at length; one hypothesis was
implemented, verified, then reverted at the owner's request pending further investigation later.

**What's been ruled out:**
- **Not a Google Sheets write-commit race.** `addLongDebtorPayment`/`addLongDebtorInvoice`/
  `editLongDebtorPayment`/`editLongDebtorInvoice` (`employee-debts-api`'s `Debts.gs`) patch a
  single Sheet row with a freshly-recomputed balance but never called `SpreadsheetApp.flush()`
  before returning — this looked like the obvious cause and was fixed. Verified via three clean,
  separate, sequential API calls (write → syncBundle → write → syncBundle) against test client
  #630: the Sheet reflected each write correctly and immediately, no lag, every time. This fix is
  a real, low-risk correctness improvement and worth re-applying whenever this area is next
  touched — but it did **not** resolve the reported symptom on its own, and was reverted along
  with everything else per the owner's "revert, I'll fix that later" request.

  **If re-applying this fix (or any other change in this area): it is not a "quick fix to just
  redeploy."** Follow this repo's/`employee-debts-api`'s existing testing discipline in full
  before considering it done — `CLAUDE.md`'s "Testing" section, in order: `clasp push`, deploy to
  the versioned deployment id, then run `runSmokeTests(employeeName, employeePin)` and confirm
  `passed === total`, specifically checking the Long-debtor checks that exercise client #630 (the
  canonical test client for this class of change, per `CLAUDE.md`). A change here that hasn't
  been pushed, deployed, *and* verified against #630 this way must not be described as fixed or
  as safe to leave live in production.
- **Not Daftra's own list-endpoint aggregation lag**, at least not exclusively — the same clean
  API-only reproduction above showed no lag even though it exercises the exact same
  `getSingleClientBalance_()` re-aggregation path.
- **Not the service worker** — `sw.js`'s fetch handler explicitly `return`s (does nothing) for
  any non-GET or cross-origin request, so it never touches API calls.
- **Not IndexedDB** — `dbSet("bundle", ...)` is only ever written from inside `doSync()`, no other
  code path could serve a stale copy.

**Leading hypothesis, not yet confirmed against the real symptom:** an unguarded race in
`doSync()` (`js/app.js`) — two overlapping sync calls (e.g. a slow one from the first action still
in flight when a second action's own sync starts and finishes first) can resolve out of order,
and whichever response lands *last* silently overwrites `APP.data`, regardless of which request
was sent last. A sequence-number guard was implemented and verified via an isolated logic test
(stubbed network, simulated out-of-order timing: confirmed the stale response gets discarded and
only the freshest one renders) — but this was **reverted** per the owner's request, since the real
reported symptom could not be force-reproduced end-to-end to confirm this was truly the cause
rather than just a real, separate bug worth fixing anyway. If picked back up: the fix lives in
`doSync()`, guarding `APP.data`/`dbSet`/`render()` behind a captured sequence number checked
against a module-level counter bumped at the start of every call.

**A promising tool discovered during this investigation, not yet used:** Daftra stamps its own
authoritative running balance onto each invoice/payment record's `extra_details.client_balance`
field at the moment it's written (`daftraEntryRunningBalance_()` in `Daftra.gs`, currently used
read-only, display-only, in the account statement). This is a more direct ground truth than
re-aggregating `summary_unpaid` across a full paginated `invoices.json` scan, and may be worth
using for the single-row Sheet patch in `addLongDebtorPayment`/`addLongDebtorInvoice` instead of
`getSingleClientBalance_()`'s full re-scan.

**Test client used for all reproduction above:** Daftra client #630 (see
`employee-debts-api`'s `CLAUDE.md`/`README.md` "Testing" section) — safe, self-cleaning, real
Daftra client name "TESTER PWA APP."

---

## GAP — WhatsApp receipt uses an optimistic, not confirmed, balance

Directly relevant to the "Financial writes must be online-only" decision (`DECISIONS.md`,
2026-09-05), requirement 4. `submitPayment`/`submitInvoice`/`submitAccountPayment` in `js/app.js`
currently compute the balance shown in the WhatsApp follow-up message client-side, before the
follow-up `doSync()` call has confirmed the server's real number —
`submitAccountPayment`'s own existing code comment literally calls it "optimistic new balance."
Needs to change so the message is built from a server-confirmed balance (ideally returned
directly in the write action's own response, avoiding a second round-trip). **Not yet
implemented** — documented only, per explicit instruction, alongside the decision above.

## GAP — No idempotency/request-ID protection on financial writes

Requirement 7 of the "Financial writes must be online-only" decision. No financial write action,
client or server side, currently has any duplicate-submission protection — a lost response after
a real Daftra success currently has no defense against the employee retrying and creating a
duplicate payment/invoice. Needs design work in `employee-debts-api` (whether Daftra's own API
supports a client-supplied reference/idempotency field is unconfirmed) before this repo's write
paths can be updated to pass one through. **Not yet implemented.**

## Confirmed non-issue — no offline write-queue exists

Not a bug: there is currently no offline/outbox queue anywhere in this codebase for retrying
failed writes later. The 2026-09-05 decision (`DECISIONS.md`) makes this permanent for financial
writes specifically — if this repo ever gains such a queue for some other kind of write, financial
writes must stay explicitly excluded from it.
