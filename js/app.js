// ============================================================
// Employee Debts / Product Search app -- standalone PWA.
//
// Talks to a separate standalone Apps Script project (see js/api.js) via
// fetch(), not google.script.run (that bridge only exists inside
// Apps Script-hosted pages). Debtor/product data is cached in IndexedDB
// (js/db.js) so browsing works offline between syncs; any write action
// (payments, follow-ups) requires a live connection -- see checkOnline()
// in api.js.
// ============================================================

const APP = {
    employee: null, // { name, pin, role }
    data: null, // { debts: {long, short, total, todayStr, snapshotTime}, products, syncedAt }
    reviewLog: null,
    view: "debtors", // "debtors" | "products"
    tab: "today",
    typeFilter: "all",
    query: "",
    expandedLog: null,
    openAction: null, // { clientId, kind: 'pay' | 'invoice' }
    draft: {},
    productQuery: "",
    activeAccount: null, // { clientId, clientName, statement } while viewing a Long Debtor's account
    activeProduct: null, // { id, name, history } while viewing a product's price history
    employeeNames: [], // [{name}] -- fetched once at the login screen, reused for the Creditor picker
    productPriceCache: {}, // productId -> last purchase entry (or null), filled in lazily per search
    pendingWhatsapp: null, // { clientName, phone, message } while the post-transaction WhatsApp prompt is open
};

const STORAGE_KEY = "employeeDebtsEmployee";

// ---------- generic helpers ----------

function money(value) {
    return Math.round(Number(value || 0)).toLocaleString();
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
}

function showLoading() {
    document.getElementById("loadingIndicator").style.display = "block";
}

function hideLoading() {
    document.getElementById("loadingIndicator").style.display = "none";
}

function showError(err) {
    alert((err && err.message) || err);
}

function todayStr() {
    return (APP.data && APP.data.debts && APP.data.debts.todayStr) || new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
    const d1 = new Date(a + "T00:00:00");
    const d2 = new Date(b + "T00:00:00");
    return Math.round((d2 - d1) / 86400000);
}

function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso) {
    if (!iso) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

// ---------- online/offline indicator ----------

function updateOnlineIndicator() {
    document.body.classList.toggle("is-offline", !navigator.onLine);
}

window.addEventListener("online", updateOnlineIndicator);
window.addEventListener("offline", updateOnlineIndicator);

// Wraps a write action: probes for a real connection first (navigator.onLine
// alone is unreliable), and only then runs the actual submit callback.
function withOnlineCheck(onOffline, run) {
    showLoading();
    checkOnline().then((online) => {
        if (!online) {
            hideLoading();
            onOffline();
            return;
        }
        run();
    });
}

// ---------- login ----------

function loadSavedEmployee() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function init() {
    updateOnlineIndicator();

    const saved = loadSavedEmployee();
    if (saved) {
        APP.employee = saved;
        showMain();
    } else {
        showLogin();
    }
}

function showLogin() {
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("mainScreen").style.display = "none";

    const errorBox = document.getElementById("loginError");
    errorBox.style.display = "none";
    document.getElementById("loginPin").value = "";

    showLoading();
    apiCall("getEmployeeNames")
        .then((names) => {
            hideLoading();
            APP.employeeNames = names;
            const select = document.getElementById("loginName");
            select.innerHTML = names.map((e) => `<option value="${escapeAttr(e.name)}">${escapeHtml(e.name)}</option>`).join("");
        })
        .catch((err) => {
            hideLoading();
            errorBox.textContent = err.message || err;
            errorBox.style.display = "block";
        });
}

function doLogin() {
    const name = document.getElementById("loginName").value;
    const pin = document.getElementById("loginPin").value;
    const errorBox = document.getElementById("loginError");

    errorBox.style.display = "none";
    showLoading();

    apiCall("authenticateEmployee", name, pin)
        .then((employee) => {
            hideLoading();
            APP.employee = { name: employee.name, pin, role: employee.role };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(APP.employee));
            showMain();
        })
        .catch((err) => {
            hideLoading();
            errorBox.textContent = err.message || err;
            errorBox.style.display = "block";
        });
}

function doLogout() {
    localStorage.removeItem(STORAGE_KEY);
    APP.employee = null;
    APP.data = null;
    APP.reviewLog = null;
    showLogin();
}

// ---------- main shell / sync ----------

function showMain() {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("mainScreen").style.display = "block";
    document.getElementById("whoAmI").textContent = APP.employee.name;

    // employeeNames only gets fetched inside showLogin() otherwise -- a
    // returning session (restored from localStorage in init()) skips
    // straight to showMain() and never calls showLogin() at all, leaving
    // this empty for the whole session and the Creditor picker showing
    // nothing but its placeholder (confirmed 2026-08-27). Fetch it here
    // too, once, if it's not already loaded.
    if (!APP.employeeNames.length) {
        apiCall("getEmployeeNames")
            .then((names) => {
                APP.employeeNames = names;
            })
            .catch(() => {
                // Non-fatal -- the Creditor picker just stays empty until
                // the next successful sync/reload.
            });
    }

    const canEdit = APP.employee.role === "edit";
    document.getElementById("addButton").style.display = canEdit ? "" : "none";
    document.getElementById("reviewButton").style.display = canEdit ? "inline-flex" : "none";
    document.getElementById("refreshDaftraButton").style.display = canEdit ? "inline-flex" : "none";

    dbGet("bundle")
        .then((cached) => {
            if (cached) {
                APP.data = cached;
                render();
            }
            return dbGet("reviewLog");
        })
        .then((cachedReview) => {
            if (cachedReview) APP.reviewLog = cachedReview;
            doSync(!APP.data);
        })
        .catch(() => doSync(true));
}

function doSync(showSpinner) {
    if (showSpinner) showLoading();

    apiCall("syncBundle", APP.employee.name, APP.employee.pin)
        .then((bundle) => {
            APP.data = bundle;
            return dbSet("bundle", bundle);
        })
        .then(() => apiCall("getDebtsReviewLog", APP.employee.name, APP.employee.pin))
        .then((reviewLog) => {
            APP.reviewLog = reviewLog;
            return dbSet("reviewLog", reviewLog);
        })
        .then(() => {
            if (showSpinner) hideLoading();
            render();
        })
        .catch((err) => {
            if (showSpinner) hideLoading();
            // A stale/removed PIN shows up here as an auth error -- bounce
            // back to login instead of a dead-end error alert.
            if (String((err && err.message) || err).indexOf("Name or PIN not recognized") !== -1) {
                doLogout();
                return;
            }
            // If we already have cached data, a failed sync (e.g. offline)
            // just means we keep showing what we've got -- not fatal.
            if (!APP.data) showError(err);
        });
}

// Pulls fresh balances from Daftra into the Debts Snapshot sheet (Long
// Debtors only -- Short Debtors are never touched by this). Can take a
// minute or two on an account with a lot of invoice history, so this is
// a manual edit-role action, not something that runs automatically on
// every sync.
function doRefreshFromDaftra() {
    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to refresh from Daftra."),
        () => {
            apiCall("refreshDebtsFromApp", APP.employee.name, APP.employee.pin)
                .then(() => doSync(true))
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

function render() {
    renderSyncBar();
    if (APP.view === "debtors") renderDebtorsView();
    else renderProductsView();
}

function renderSyncBar() {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.textContent = APP.data && APP.data.syncedAt ? `Synced ${timeAgo(APP.data.syncedAt)}` : "Not synced yet";
}

function setView(view) {
    APP.view = view;
    document.querySelectorAll(".debtBottomNavBtn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-view") === view);
    });
    document.getElementById("debtorsView").style.display = view === "debtors" ? "block" : "none";
    document.getElementById("productsView").style.display = view === "products" ? "block" : "none";
    document.getElementById("addButton").style.display = view === "debtors" && APP.employee.role === "edit" ? "" : "none";
    render();
}

// ============================================================
// Debtors view
// ============================================================

function debtsAllList() {
    if (!APP.data || !APP.data.debts) return [];
    return APP.data.debts.long.concat(APP.data.debts.short);
}

function debtsAllLogEntries() {
    const rows = [];
    debtsAllList().forEach((d) => {
        (d.log || []).forEach((e) => rows.push(Object.assign({}, e, { clientName: d.clientName })));
    });
    return rows.sort((a, b) => new Date(b.time) - new Date(a.time));
}

function debtsUnreviewedCount() {
    if (!APP.reviewLog) return 0;
    return debtsAllLogEntries().filter((e) => !APP.reviewLog[e.id]).length;
}

function renderDebtorsView() {
    if (!APP.data) return;

    const list = debtsAllList();
    const todayCount = list.filter((d) => d.status === "active" && d.lastFollowUp !== todayStr()).length;

    document.getElementById("debtsTotal").textContent = money(APP.data.debts.total);
    // Outstanding total is edit-role only (owner's request, 2026-08-27) --
    // view-only employees can still see individual debtor balances, just
    // not the shop-wide total.
    document.getElementById("debtsOutstandingBlock").style.display = APP.employee.role === "edit" ? "" : "none";
    document.getElementById("debtsSnapshotTime").textContent = APP.data.debts.snapshotTime
        ? "Daftra last pulled " + APP.data.debts.snapshotTime
        : "";

    const chaseEl = document.getElementById("debtsChaseToday");
    if (todayCount > 0) {
        chaseEl.style.display = "inline-flex";
        chaseEl.textContent = `${todayCount} to chase today`;
    } else {
        chaseEl.style.display = "none";
    }

    const unread = debtsUnreviewedCount();
    const reviewBadge = document.getElementById("reviewBadge");
    if (unread > 0) {
        reviewBadge.style.display = "inline-flex";
        reviewBadge.textContent = unread > 9 ? "9+" : unread;
    } else {
        reviewBadge.style.display = "none";
    }

    const counts = {
        today: todayCount,
        active: list.filter((d) => d.status === "active").length,
        paid: list.filter((d) => d.status === "paid").length,
        dead: list.filter((d) => d.status === "dead").length,
    };

    document.querySelectorAll("#debtsTabs .debtTab").forEach((btn) => {
        const tab = btn.getAttribute("data-tab");
        btn.classList.toggle("active", tab === APP.tab);
        btn.querySelector(".debtTabCount").textContent = counts[tab];
    });

    document.querySelectorAll("#debtsTypeToggle .debtTypeOpt").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-type") === APP.typeFilter);
    });

    renderDebtorsList();
}

function setDebtsTab(tab) {
    APP.tab = tab;
    render();
}

function setDebtsTypeFilter(type) {
    APP.typeFilter = type;
    render();
}

function renderDebtorsList() {
    APP.query = document.getElementById("debtsSearch").value.trim().toLowerCase();

    let list = debtsAllList();

    // A search query bypasses the tab entirely -- otherwise a paid-off
    // Short Debtor (kept around on purpose so a repeat debt reopens the
    // same record, see addShortDebt()) would only turn up while sitting on
    // the "Paid" tab, defeating the point of being able to just search for
    // them (owner's request, 2026-08-26). Their card still correctly shows
    // a zero remaining balance since amountPaid == amount once paid.
    if (APP.query) {
        list = list.filter((d) => d.clientName.toLowerCase().includes(APP.query));
    } else if (APP.tab === "today") {
        list = list.filter((d) => d.status === "active" && d.lastFollowUp !== todayStr());
    } else {
        list = list.filter((d) => d.status === APP.tab);
    }

    if (APP.typeFilter !== "all") {
        list = list.filter((d) => d.type.toLowerCase() === APP.typeFilter);
    }

    // Biggest remaining balance first -- due-date-based ordering doesn't
    // apply anymore now that due dates aren't tracked in the UI
    // (2026-08-26).
    list = list.slice().sort((a, b) => (b.amount - b.amountPaid) - (a.amount - a.amountPaid));

    const container = document.getElementById("debtsList");
    const empty = document.getElementById("debtsEmpty");
    const canEdit = APP.employee.role === "edit";

    if (list.length === 0) {
        container.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = APP.tab === "today" ? "Nothing to chase today. Clean slate." : "No entries here yet.";
        return;
    }

    empty.style.display = "none";
    // One bad record's data shouldn't be able to blank the entire list --
    // catch per-card so a single exception just skips that card instead
    // of aborting the whole innerHTML assignment (a non-string phone
    // field once did exactly this before phone was removed from the
    // card entirely, 2026-08-22/26).
    container.innerHTML = list
        .map((d) => {
            try {
                return debtCardHtml(d, canEdit);
            } catch (e) {
                console.error("debtCardHtml failed for", d.clientName, e);
                return `<div class="debtCard">${escapeHtml(d.clientName)} -- couldn't render this card (${escapeHtml(e.message)})</div>`;
            }
        })
        .join("");
}


// A fixed font-size overflowed the balance ring for any debtor owing a
// large amount -- scale down as the formatted number gets longer instead.
// Tuned against the ring's ~62px usable width (74px ring minus the 6px
// inset on each side); wraps to 2 lines for anything longer than that
// still allows.
function debtBalanceFontSize_(text) {
    if (text.length > 10) return 10;
    if (text.length > 8) return 11;
    if (text.length > 6) return 13;
    return 15;
}

function debtCardHtml(d, canEdit) {
    const remaining = d.amount - d.amountPaid;
    const pct = d.amount > 0 ? Math.min(100, Math.round((d.amountPaid / d.amount) * 100)) : 0;
    const balanceText = money(remaining);
    const balanceFontSize = debtBalanceFontSize_(balanceText);
    const action = APP.openAction && APP.openAction.clientId === d.clientId ? APP.openAction.kind : null;
    const typePill = d.type === "Short" ? "Notebook" : "Daftra";
    const isLong = d.type !== "Short";
    const logOpen = APP.expandedLog === d.clientId;
    const createdBy = d.log && d.log.length ? d.log[0].actor : "";

    // "Client account" opens the real Daftra statement for a Long debtor;
    // a Short debtor has no Daftra account, so it just expands their local
    // follow-up history instead -- same underlying log data either way.
    const accountOnclick = isLong
        ? `openAccount('${d.clientId}','${escapeAttr(d.clientName)}',${remaining})`
        : `toggleDebtLog('${d.clientId}')`;

    let actionsHtml = "";

    // Add Payment / Add invoice restored for Daftra (Long) debtors
    // (owner's request, 2026-08-28 -- briefly removed on 2026-08-27).
    // Both types now get the same three actions; only the Creditor picker
    // on the "Add invoice" form stays Short-only (isShort check below),
    // since that concept doesn't apply to a real Daftra invoice.
    if (d.status === "active" && canEdit) {
        if (action === "pay") {
            actionsHtml = `
                <div class="debtActionForm">
                    <input type="number" id="draft-${d.clientId}" placeholder="Amount paid (up to ${money(remaining)})" value="${escapeAttr(APP.draft[d.clientId] || "")}" oninput="APP.draft['${d.clientId}']=this.value" />
                    <div class="debtActionButtons">
                        <button type="button" class="debtBtn debtBtnSage" onclick="submitPayment('${d.clientId}')">Record payment</button>
                        <button type="button" class="debtBtn debtBtnGhost" onclick="closeAction()">X</button>
                    </div>
                </div>`;
        } else if (action === "invoice") {
            const isShort = !isLong;
            const creditorOptions = isShort
                ? APP.employeeNames
                      .map((e) => `<option value="${escapeAttr(e.name)}" ${e.name === (d.creditor || APP.employee.name) ? "selected" : ""}>${escapeHtml(e.name)}</option>`)
                      .join("")
                : "";
            actionsHtml = `
                <div class="debtActionForm">
                    <input type="number" id="draft-${d.clientId}" placeholder="Additional amount owed" value="${escapeAttr(APP.draft[d.clientId] || "")}" oninput="APP.draft['${d.clientId}']=this.value" />
                    ${isShort ? `<select id="draftCreditor-${d.clientId}">${creditorOptions}</select>` : ""}
                    <div class="debtActionButtons">
                        <button type="button" class="debtBtn debtBtnDark" onclick="submitInvoice('${d.clientId}')">Add invoice</button>
                        <button type="button" class="debtBtn debtBtnGhost" onclick="closeAction()">X</button>
                    </div>
                </div>`;
        } else {
            actionsHtml = `
                <div class="debtActionRow">
                    <button type="button" class="debtBtn debtBtnPrimary" onclick="openAction('${d.clientId}','pay')">Add Payment</button>
                    <button type="button" class="debtBtn debtBtnDark" onclick="openAction('${d.clientId}','invoice')">Add invoice</button>
                    <button type="button" class="debtBtn debtBtnGhost" onclick="${accountOnclick}">Client account</button>
                </div>`;
        }
    } else if (d.status !== "active") {
        actionsHtml = `
            <div class="debtResolvedRow">
                <span class="debtResolvedLabel debtResolvedLabel-${d.status}">${d.status === "paid" ? "Paid" : "Dead debt"}</span>
                ${canEdit ? `<button type="button" class="debtBtn debtBtnGhost" onclick="submitStatus('${d.clientId}','active')">Reopen</button>` : ""}
            </div>`;
    } else {
        actionsHtml = `<div class="debtActionRow"><button type="button" class="debtBtn debtBtnGhost" onclick="${accountOnclick}">Client account</button></div>`;
    }

    return `
        <div class="debtCard ${d.isAgingShort ? "debtCard-aging" : ""}">
            <div class="debtCardTop">
                <div class="debtBalanceRing" style="--pct: ${pct}">
                    <span class="debtBalanceNum" style="font-size: ${balanceFontSize}px">${escapeHtml(balanceText)}</span>
                </div>
                <div class="debtCardMain">
                    <div class="debtCardHead">
                        <div>
                            <span class="debtTypePill debtTypePill-${d.type.toLowerCase()}">${typePill}</span>
                            ${d.creditor ? `<span class="debtCreditorPill">${escapeHtml(d.creditor)}</span>` : ""}
                            ${d.needsReconciliation ? `<span class="debtReconcilePill">⚠️ May not match Daftra</span>` : ""}
                            ${d.isAgingShort ? `<div class="debtAgingFlag">Open ${daysBetween(d.dateGiven, todayStr())}d - consider a Daftra invoice</div>` : ""}
                            <div class="debtName">${escapeHtml(d.clientName)}</div>
                        </div>
                        <button type="button" class="debtShareBtn" onclick="shareDebtorBalance_('${d.clientId}')" aria-label="Share balance">📤</button>
                    </div>
                    ${actionsHtml}
                    ${
                        logOpen
                            ? `<div class="debtLog">${d.log
                                  .slice()
                                  .reverse()
                                  .map((e) => `<div class="debtLogRow"><span class="debtLogTime">${fmtDateTime(e.time)}</span> | ${escapeHtml(e.actor)} - ${escapeHtml(e.note)}</div>`)
                                  .join("")}</div>`
                            : ""
                    }
                    ${createdBy ? `<div class="debtCreatedBy">Added by ${escapeHtml(createdBy)}</div>` : ""}
                </div>
            </div>
        </div>`;
}

function toggleDebtLog(clientId) {
    APP.expandedLog = APP.expandedLog === clientId ? null : clientId;
    render();
}

function openAction(clientId, kind) {
    APP.openAction = { clientId, kind };
    delete APP.draft[clientId];
    render();
    setTimeout(() => {
        const el = document.getElementById(`draft-${clientId}`);
        if (el) el.focus();
    }, 0);
}

function closeAction() {
    APP.openAction = null;
    render();
}

// ============================================================
// WhatsApp follow-up -- after a payment is recorded or a debt is added,
// prompt to tell the client their new balance (owner's request,
// 2026-08-27). Uses a wa.me deep link rather than sending automatically:
// that needs the official WhatsApp Business API (Meta verification,
// pre-approved templates, per-conversation cost), a much bigger lift for
// two fixed templates -- this opens WhatsApp with the message already
// typed, the employee just reviews and taps Send there.
// ============================================================

function buildDebtAddedMessage_(addedAmount, newTotal) {
    return `باقي عليك من فاتورة اليوم ${money(addedAmount)}، اجمالي عليك ${money(newTotal)}`;
}

function buildPaymentMessage_(paidAmount, newRemaining) {
    return `واصل ${money(paidAmount)} وباقي ${money(newRemaining)}`;
}

// On-demand share button on every card -- separate from the automatic
// post-transaction WhatsApp prompt above, this lets an employee share a
// debtor's CURRENT balance at any time (owner's request, 2026-08-28), not
// just right after recording something. Uses the OS share sheet
// (WhatsApp, SMS, copy, etc. -- whatever the device offers) rather than a
// WhatsApp-only link, since this isn't necessarily going to the debtor.
// WhatsApp-only (owner's request, 2026-08-28) -- straight to the
// debtor's own chat if a phone is on file (same normalization as the
// automatic follow-up prompt), otherwise a plain wa.me link with no
// number, which opens WhatsApp's own contact picker instead of failing.
function shareDebtorBalance_(clientId) {
    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
    if (!d) return;

    const remaining = d.amount - d.amountPaid;
    const text = `اجمالي عليك: ${money(remaining)}`;
    const digits = normalizePhoneForWhatsapp_(d.phone);
    // wa.me needs an actual number in the path -- an empty segment
    // doesn't behave as "no contact". api.whatsapp.com/send with no
    // "phone" param is WhatsApp's own documented way to open with a
    // message ready and no target chat picked, landing on the contact
    // picker instead.
    const link = digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
        : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;

    window.open(link, "_blank", "noopener,noreferrer");
}

// wa.me needs country-code + number with NO leading "+" or "00" -- e.g.
// "966537680173", not "00966537680173" or "0537680173". Confirmed
// 2026-08-28: a real number stored as "00966537680173" (Saudi's
// international dialing prefix, "00", left on) made WhatsApp itself
// reject it as "missing a country code or has the wrong one".
function normalizePhoneForWhatsapp_(phone) {
    let digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";

    if (digits.startsWith("00")) {
        digits = digits.slice(2); // international-dialing prefix, not part of the number
    } else if (digits.startsWith("0")) {
        digits = "966" + digits.slice(1); // local format, no country code -- assume Saudi Arabia
    }

    return digits;
}

function buildWhatsappLink_(phone, message) {
    const digits = normalizePhoneForWhatsapp_(phone);
    if (!digits) return null;
    return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// No phone on file -> skip the prompt entirely rather than showing a dead
// end with no way to actually send anything.
function promptWhatsappFollowUp_(clientName, phone, message) {
    const link = buildWhatsappLink_(phone, message);
    if (!link) return;

    APP.pendingWhatsapp = { clientName, phone, message };
    document.getElementById("whatsappPromptName").textContent = clientName;
    document.getElementById("whatsappPromptMessage").textContent = message;
    document.getElementById("whatsappPromptLink").href = link;
    document.getElementById("whatsappPrompt").style.display = "flex";
}

function closeWhatsappPrompt() {
    APP.pendingWhatsapp = null;
    document.getElementById("whatsappPrompt").style.display = "none";
}

// ============================================================
// Sync status toast -- shows exactly what saved where after a write
// (owner's request, 2026-08-28, after a Daftra-side failure went
// unnoticed: the app looked like it worked because the Google Sheet
// update alone is enough to make a card look up to date). parts:
// [{ label, ok }].
// ============================================================

let syncToastTimer_ = null;

function showSyncToast_(parts) {
    const toast = document.getElementById("syncToast");
    toast.innerHTML = parts
        .map((p) => `<span class="syncToastItem-${p.ok ? "ok" : "fail"}">${p.ok ? "✓" : "✗"} ${escapeHtml(p.label)}</span>`)
        .join("");
    toast.style.display = "flex";

    clearTimeout(syncToastTimer_);
    syncToastTimer_ = setTimeout(() => {
        toast.style.display = "none";
    }, 5000);
}

// Local sheet-only update for a Short (Notebook) debtor; a real Daftra
// payment for a Long debtor (confirmed 2026-08-28: this always called
// the local-only recordDebtPayment regardless of type, so "Add Payment"
// on a Daftra client's card looked like it worked -- Debts Snapshot
// updated -- but never actually touched Daftra. Matches the branching
// submitInvoice() already does per type).
function submitPayment(clientId) {
    const amount = APP.draft[clientId];
    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
    const isShort = d && d.type === "Short";
    const action = isShort ? "recordDebtPayment" : "addLongDebtorPayment";
    const params = isShort ? [clientId, amount] : [clientId, amount, ""];

    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to record a payment."),
        () => {
            apiCall(action, APP.employee.name, APP.employee.pin, ...params)
                .then((result) => {
                    APP.openAction = null;
                    delete APP.draft[clientId];
                    showSyncToast_(
                        isShort
                            ? [{ label: "Google Sheet", ok: true }]
                            : [{ label: "Daftra", ok: true }, { label: "Google Sheet", ok: !!(result && result.sheetUpdated) }],
                    );
                    if (d) {
                        const newRemaining = Math.max(0, d.amount - d.amountPaid - Number(amount));
                        promptWhatsappFollowUp_(d.clientName, d.phone, buildPaymentMessage_(amount, newRemaining));
                    }
                    doSync(true);
                })
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

// Increases what a debtor owes -- a local sheet update for a Short
// (Notebook) debtor, a real new Daftra due invoice for a Long debtor
// (owner's request, 2026-08-26: same "Add invoice" button either way;
// briefly Short-only 2026-08-27, restored for Long debtors 2026-08-28).
function submitInvoice(clientId) {
    const amount = APP.draft[clientId];
    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
    const isShort = d && d.type === "Short";
    const action = isShort ? "addToShortDebt" : "addLongDebtorInvoice";
    // Creditor picker only exists on the Short-debtor form -- that
    // concept doesn't apply to a real Daftra invoice, so this element
    // won't be present on a Long debtor's card.
    const creditorEl = document.getElementById(`draftCreditor-${clientId}`);
    const params = isShort ? [clientId, amount, "", creditorEl ? creditorEl.value : ""] : [clientId, amount];

    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to add an invoice."),
        () => {
            apiCall(action, APP.employee.name, APP.employee.pin, ...params)
                .then((result) => {
                    APP.openAction = null;
                    delete APP.draft[clientId];
                    showSyncToast_(
                        isShort
                            ? [{ label: "Google Sheet", ok: true }]
                            : [{ label: "Daftra", ok: true }, { label: "Google Sheet", ok: !!(result && result.sheetUpdated) }],
                    );
                    if (d) {
                        const newTotal = d.amount - d.amountPaid + Number(amount);
                        promptWhatsappFollowUp_(d.clientName, d.phone, buildDebtAddedMessage_(amount, newTotal));
                    }
                    doSync(true);
                })
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

function submitStatus(clientId, status) {
    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to make this change."),
        () => {
            apiCall("setDebtStatus", APP.employee.name, APP.employee.pin, clientId, status)
                .then(() => doSync(true))
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

// --- Add a short debt ---

function toggleAddShortForm() {
    const form = document.getElementById("addShortForm");
    const isOpen = form.style.display === "flex";
    form.style.display = isOpen ? "none" : "flex";

    if (!isOpen) {
        document.getElementById("newName").value = "";
        document.getElementById("newPhone").value = "";
        document.getElementById("newAmount").value = "";
        document.getElementById("newDateGiven").value = todayStr();
        document.getElementById("newNotes").value = "";
        document.getElementById("addShortError").style.display = "none";

        const creditorSelect = document.getElementById("newCreditor");
        creditorSelect.innerHTML =
            `<option value="">Who gave this credit?</option>` +
            APP.employeeNames.map((e) => `<option value="${escapeAttr(e.name)}">${escapeHtml(e.name)}</option>`).join("");
        creditorSelect.value = APP.employee.name; // defaults to whoever's adding it, easy to change
    }
}

function submitShortDebt() {
    const name = document.getElementById("newName").value.trim();
    const phone = document.getElementById("newPhone").value.trim();
    const amount = document.getElementById("newAmount").value;
    const dateGiven = document.getElementById("newDateGiven").value;
    const notes = document.getElementById("newNotes").value.trim();
    const creditor = document.getElementById("newCreditor").value;
    const errorBox = document.getElementById("addShortError");

    errorBox.style.display = "none";

    withOnlineCheck(
        () => {
            errorBox.textContent = "You're offline -- connect to the internet to add this.";
            errorBox.style.display = "block";
        },
        () => {
            // Due date is left blank -- it's no longer tracked/shown
            // anywhere in the UI (2026-08-26), but the API still expects
            // a value in this position for addShortDebt()'s existing
            // signature.
            apiCall("addShortDebt", APP.employee.name, APP.employee.pin, name, amount, phone, "", dateGiven, notes, creditor)
                .then(() => {
                    toggleAddShortForm();
                    doSync(true);
                })
                .catch((err) => {
                    hideLoading();
                    errorBox.textContent = err.message || err;
                    errorBox.style.display = "block";
                });
        },
    );
}

// ============================================================
// Long Debtor account -- statement + real Daftra payment. Both need a
// live connection (statement isn't pre-synced -- could be a lot of
// history per client, and is less time-sensitive to browse offline than
// the debtor list itself).
// ============================================================

function openAccount(clientId, clientName, balance) {
    // `balance` is the debtor's already-known outstanding amount (from
    // the Debts Snapshot, via Daftra's summary_unpaid) -- shown as-is
    // rather than recomputed from the last-30-days activity list below,
    // since a running total over a partial window would be a confusingly
    // wrong number for any debt older than 30 days.
    APP.activeAccount = { clientId, clientName, balance, statement: null };
    document.getElementById("accountPanel").style.display = "flex";
    document.getElementById("accountName").textContent = clientName;
    document.getElementById("accountBody").innerHTML = `<div class="emptyState">Loading...</div>`;

    if (!navigator.onLine) {
        document.getElementById("accountBody").innerHTML = `<div class="emptyState">You're offline -- the account statement needs a live connection.</div>`;
        return;
    }

    apiCall("getLongDebtorAccount", APP.employee.name, APP.employee.pin, clientId)
        .then((statement) => {
            APP.activeAccount.statement = statement;
            renderAccountSheet();
        })
        .catch((err) => {
            document.getElementById("accountBody").innerHTML = `<div class="emptyState">${escapeHtml(err.message || String(err))}</div>`;
        });
}

function closeAccount() {
    APP.activeAccount = null;
    document.getElementById("accountPanel").style.display = "none";
}

function renderAccountSheet() {
    const statement = APP.activeAccount.statement;
    const canEdit = APP.employee.role === "edit";
    const clientId = APP.activeAccount.clientId;
    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
    const needsReconciliation = !!(d && d.needsReconciliation);

    const rows = statement.entries
        .map(
            (e) => `
            <div class="acctRow">
                <div class="acctRowDesc">
                    <div>${escapeHtml(e.description)}</div>
                    <div class="acctRowDate">${escapeHtml(String(e.date || ""))}</div>
                </div>
                <div class="acctRowAmount ${e.amount < 0 ? "negative" : ""}">${e.amount < 0 ? "-" : ""}${money(Math.abs(e.amount))}</div>
            </div>`,
        )
        .join("");

    document.getElementById("accountBody").innerHTML = `
        <div class="acctBalance">
            <div class="acctBalanceLabel">Balance</div>
            <div class="acctBalanceValue">${money(APP.activeAccount.balance)}</div>
        </div>
        <div class="debtSheetHint">Last ${statement.entries.length} transaction${statement.entries.length === 1 ? "" : "s"}</div>
        <div class="acctStatementList">${rows || '<div class="emptyState">No activity recorded yet.</div>'}</div>
        ${
            canEdit
                ? `
            <div class="debtLoginLabel">Add payment</div>
            <input type="number" id="acctPayAmount" class="debtLoginInput" placeholder="Amount" />
            <input type="text" id="acctPayNote" class="debtLoginInput" placeholder="Note (optional)" style="margin-top: 8px" />
            <button type="button" class="debtBtn debtBtnSage debtLoginButton" onclick="submitAccountPayment()">Record payment in Daftra</button>
            <button type="button" class="debtBtn debtLoginButton" style="margin-top: 8px" onclick="toggleReconciliation_()">${
                needsReconciliation ? "✓ Clear reconciliation flag" : "⚠️ Flag as needs reconciliation"
            }</button>
            `
                : ""
        }
    `;
}

function toggleReconciliation_() {
    const clientId = APP.activeAccount.clientId;
    apiCall("toggleReconciliationFlag", APP.employee.name, APP.employee.pin, clientId)
        .then((result) => {
            const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
            if (d) d.needsReconciliation = result.needsReconciliation;
            renderAccountSheet();
            renderDebtorsList();
        })
        .catch((err) => alert("Could not update flag: " + err.message));
}

function submitAccountPayment() {
    const clientId = APP.activeAccount.clientId;
    const amount = document.getElementById("acctPayAmount").value;
    const note = document.getElementById("acctPayNote").value.trim();

    if (!Number(amount) || Number(amount) <= 0) {
        showError("Enter an amount greater than zero.");
        return;
    }

    if (!confirm(`Record a payment of ${money(amount)} to ${APP.activeAccount.clientName}'s Daftra account?`)) return;

    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to record a payment."),
        () => {
            apiCall("addLongDebtorPayment", APP.employee.name, APP.employee.pin, clientId, amount, note)
                .then((result) => {
                    hideLoading();
                    showSyncToast_([{ label: "Daftra", ok: true }, { label: "Google Sheet", ok: !!(result && result.sheetUpdated) }]);
                    const newBalance = APP.activeAccount.balance - Number(amount);
                    const clientName = APP.activeAccount.clientName;
                    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
                    if (d) promptWhatsappFollowUp_(clientName, d.phone, buildPaymentMessage_(amount, newBalance));
                    // Optimistic new balance -- doSync() below fetches the
                    // real one right after; this just avoids a flash of
                    // the stale pre-payment figure in the meantime.
                    openAccount(clientId, clientName, newBalance);
                    doSync(false);
                })
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

// ============================================================
// Product search -- name/SKU search works offline from the synced
// catalog; price history needs a live connection (see Daftra.gs in the
// API project for why this isn't pre-synced for the whole catalog).
// ============================================================

function renderProductsView() {
    const query = document.getElementById("productSearch").value.trim().toLowerCase();
    const container = document.getElementById("productList");
    const empty = document.getElementById("productsEmpty");

    if (!query) {
        container.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = "Search for a product by name or SKU.";
        return;
    }

    const all = (APP.data && APP.data.products) || [];
    // String()-coerce name/sku before comparing -- a Sheets-cell-sourced
    // SKU that looks numeric (e.g. "2038") can come back from the API as
    // an actual number rather than a string, and .toLowerCase() on a
    // number threw here, silently killing the whole search (confirmed
    // 2026-08-26). Fixed at the source too (Daftra.gs's getAllProducts()),
    // but this stays as a second line of defense.
    const matches = all
        .filter((p) => String(p.name || "").toLowerCase().includes(query) || String(p.sku || "").toLowerCase().includes(query))
        .slice(0, 30);

    if (matches.length === 0) {
        container.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = "No products match that search.";
        return;
    }

    empty.style.display = "none";
    // Last price/supplier is a real live Daftra lookup per product (not
    // pre-synced like name/SKU -- see getDaftraProductPurchaseHistory's
    // header comment for why), so it's only fetched for the first few
    // visible results instead of every match. A broad search could return
    // up to 30 products; firing that many lookups at once would be slow
    // and hammer the API (owner's request, 2026-08-27).
    const LAST_PRICE_LIMIT = 8;

    container.innerHTML = matches
        .map(
            (p, i) => `
        <button type="button" class="productCard" onclick="openProductHistory('${p.id}','${escapeAttr(p.name)}')">
            <div class="productName">${escapeHtml(p.name)}</div>
            ${i < LAST_PRICE_LIMIT ? `<div class="productLastPurchase" id="productLastPurchase_${p.id}">Loading last price...</div>` : ""}
        </button>`,
        )
        .join("");

    matches.slice(0, LAST_PRICE_LIMIT).forEach((p) => loadProductLastPurchase_(p.id));
}

// Cached per product id for the session -- once fetched, re-rendering the
// same search (or searching again later) doesn't re-fetch it.
function loadProductLastPurchase_(productId) {
    const el = document.getElementById(`productLastPurchase_${productId}`);
    if (!el) return;

    if (Object.prototype.hasOwnProperty.call(APP.productPriceCache, productId)) {
        renderProductLastPurchase_(el, APP.productPriceCache[productId]);
        return;
    }

    if (!navigator.onLine) {
        el.textContent = "";
        return;
    }

    apiCall("getProductPurchaseHistory", APP.employee.name, APP.employee.pin, productId)
        .then((history) => {
            const last = (history && history[0]) || null;
            APP.productPriceCache[productId] = last;
            // Re-query the element rather than reusing `el` -- the user
            // may have typed a different search (or scrolled a new list
            // into place) by the time this resolves.
            const freshEl = document.getElementById(`productLastPurchase_${productId}`);
            if (freshEl) renderProductLastPurchase_(freshEl, last);
        })
        .catch(() => {
            const freshEl = document.getElementById(`productLastPurchase_${productId}`);
            if (freshEl) freshEl.textContent = "";
        });
}

function renderProductLastPurchase_(el, last) {
    if (!last) {
        el.textContent = "No purchase history";
        return;
    }
    el.innerHTML = `<span class="productLastPurchasePrice">${money(last.purchasePrice)}</span>${last.supplierName ? ` - ${escapeHtml(last.supplierName)}` : ""}`;
}

function openProductHistory(productId, productName) {
    APP.activeProduct = { id: productId, name: productName, history: null };
    document.getElementById("productPanel").style.display = "flex";
    document.getElementById("productPanelName").textContent = productName;
    document.getElementById("productPanelBody").innerHTML = `<div class="emptyState">Loading...</div>`;

    if (!navigator.onLine) {
        document.getElementById("productPanelBody").innerHTML = `<div class="emptyState">You're offline -- purchase price history needs a live connection.</div>`;
        return;
    }

    apiCall("getProductPurchaseHistory", APP.employee.name, APP.employee.pin, productId)
        .then((history) => {
            APP.activeProduct.history = history;
            renderProductHistory();
        })
        .catch((err) => {
            document.getElementById("productPanelBody").innerHTML = `<div class="emptyState">${escapeHtml(err.message || String(err))}</div>`;
        });
}

function closeProductHistory() {
    APP.activeProduct = null;
    document.getElementById("productPanel").style.display = "none";
}

function renderProductHistory() {
    const history = APP.activeProduct.history || [];

    if (history.length === 0) {
        document.getElementById("productPanelBody").innerHTML = `<div class="emptyState">No purchase history found for this product.</div>`;
        return;
    }

    document.getElementById("productPanelBody").innerHTML = `
        <div class="productHistoryList">
            ${history
                .map(
                    (h) => `
                <div class="productHistoryRow">
                    <div>
                        <div class="productHistorySupplier">${escapeHtml(h.supplierName || "")}</div>
                        <div class="productHistoryDate">${escapeHtml(String(h.date || ""))}</div>
                    </div>
                    <div class="productHistoryPrice">${money(h.purchasePrice)}</div>
                </div>`,
                )
                .join("")}
        </div>`;
}

// ============================================================
// Review checklist
// ============================================================

function openReview() {
    document.getElementById("reviewPanel").style.display = "flex";
    renderReview();
}

function closeReview() {
    document.getElementById("reviewPanel").style.display = "none";
}

function renderReview() {
    const entries = debtsAllLogEntries();
    const list = document.getElementById("reviewList");

    if (entries.length === 0) {
        list.innerHTML = `<div class="emptyState">No activity yet.</div>`;
        return;
    }

    list.innerHTML = entries
        .map((e) => {
            const isReviewed = !!(APP.reviewLog && APP.reviewLog[e.id]);
            return `
                <button type="button" class="debtReviewRow ${isReviewed ? "reviewed" : ""}" onclick="toggleReviewEntry('${e.id}')">
                    <span class="debtReviewCheck">${isReviewed ? "OK" : ""}</span>
                    <span class="debtReviewText">
                        <span class="debtReviewLine"><strong>${escapeHtml(e.clientName)}</strong> - ${escapeHtml(e.note)}</span>
                        <span class="debtReviewMeta">${escapeHtml(e.actor)} | ${fmtDateTime(e.time)}</span>
                    </span>
                </button>`;
        })
        .join("");
}

function toggleReviewEntry(entryId) {
    apiCall("toggleDebtReviewEntry", APP.employee.name, APP.employee.pin, entryId)
        .then((result) => {
            if (!APP.reviewLog) APP.reviewLog = {};
            if (result.reviewed) {
                APP.reviewLog[entryId] = { by: APP.employee.name, at: "" };
            } else {
                delete APP.reviewLog[entryId];
            }
            dbSet("reviewLog", APP.reviewLog);
            renderReview();
            renderDebtorsView();
        })
        .catch(showError);
}

document.addEventListener("DOMContentLoaded", init);
