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
    openAction: null, // { clientId, kind: 'note' | 'pay' | 'due' }
    draft: {},
    productQuery: "",
    activeAccount: null, // { clientId, clientName, statement } while viewing a Long Debtor's account
    activeProduct: null, // { id, name, history } while viewing a product's price history
    employeeNames: [], // [{name}] -- fetched once at the login screen, reused for the Creditor picker
};

const STORAGE_KEY = "employeeDebtsEmployee";

// ---------- generic helpers ----------

function money(value) {
    return Number(value || 0).toLocaleString();
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

function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
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

function dueInfo(d) {
    if (d.status !== "active") {
        return { label: d.status === "paid" ? "Paid" : "Dead debt", cls: "debtBadge-" + d.status };
    }
    if (!d.dueDate) return { label: "no date", cls: "debtBadge-none" };

    const diff = daysBetween(todayStr(), d.dueDate);

    if (diff > 3) return { label: `${diff}d left`, cls: "debtBadge-ok", diff };
    if (diff > 0) return { label: `${diff}d left`, cls: "debtBadge-soon", diff };
    if (diff === 0) return { label: "due today", cls: "debtBadge-today", diff };
    return { label: `+${Math.abs(diff)}d over`, cls: "debtBadge-over", diff };
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

    if (APP.tab === "today") {
        list = list.filter((d) => d.status === "active" && d.lastFollowUp !== todayStr());
    } else {
        list = list.filter((d) => d.status === APP.tab);
    }

    if (APP.typeFilter !== "all") {
        list = list.filter((d) => d.type.toLowerCase() === APP.typeFilter);
    }

    if (APP.query) {
        list = list.filter((d) => d.clientName.toLowerCase().includes(APP.query));
    }

    list = list.slice().sort((a, b) => {
        const da = a.dueDate ? daysBetween(todayStr(), a.dueDate) : Infinity;
        const db = b.dueDate ? daysBetween(todayStr(), b.dueDate) : Infinity;
        return da - db;
    });

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
    // of aborting the whole innerHTML assignment (see debtWaLink()'s
    // comment for the real case that caused this).
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

function debtWaLink(d) {
    // Daftra occasionally hands back a phone field as a number, not a
    // string (confirmed 2026-08-22 -- a single non-string phone value
    // was throwing here and silently blanking the ENTIRE debtor list,
    // since one exception inside the render map aborted the whole
    // innerHTML assignment). String() first, always.
    const digits = String(d.phone || "").replace(/\D/g, "");
    if (!digits) return null;

    const remaining = d.amount - d.amountPaid;
    const when = d.dueDate ? (d.dueDate === todayStr() ? "today" : `on ${fmtDate(d.dueDate)}`) : "soon";
    const msg = `Hi ${d.clientName}, friendly reminder that your balance of ${money(remaining)} is due ${when}. Could you let us know when you can settle it? Thank you!`;

    return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function debtCardHtml(d, canEdit) {
    const due = dueInfo(d);
    const remaining = d.amount - d.amountPaid;
    const lastEntry = d.log && d.log.length ? d.log[d.log.length - 1] : null;
    const logOpen = APP.expandedLog === d.clientId;
    const action = APP.openAction && APP.openAction.clientId === d.clientId ? APP.openAction.kind : null;
    const wa = debtWaLink(d);
    const typePill = d.type === "Short" ? "Notebook" : "Daftra";
    const isLong = d.type !== "Short";

    const metaBits = [
        d.dateGiven ? `Given ${fmtDate(d.dateGiven)}` : "",
        d.dueDate ? `Due ${fmtDate(d.dueDate)}` : "",
        d.promiseCount > 0 ? `Rescheduled x${d.promiseCount}` : "",
        d.phone ? `<a href="tel:${escapeAttr(d.phone)}" class="debtPhone">Tel: ${escapeHtml(d.phone)}</a>` : "",
    ].filter(Boolean);

    let actionsHtml = "";

    if (d.status === "active" && canEdit) {
        if (action === "note") {
            actionsHtml = `
                <div class="debtActionForm">
                    <input type="text" id="draft-${d.clientId}" placeholder="What happened? (optional)" value="${escapeAttr(APP.draft[d.clientId] || "")}" oninput="APP.draft['${d.clientId}']=this.value" />
                    <div class="debtActionButtons">
                        <button type="button" class="debtBtn debtBtnSage" onclick="submitFollowUp('${d.clientId}')">Save</button>
                        <button type="button" class="debtBtn debtBtnGhost" onclick="closeAction()">X</button>
                    </div>
                </div>`;
        } else if (action === "pay") {
            actionsHtml = `
                <div class="debtActionForm">
                    <input type="number" id="draft-${d.clientId}" placeholder="Amount paid (up to ${money(remaining)})" value="${escapeAttr(APP.draft[d.clientId] || "")}" oninput="APP.draft['${d.clientId}']=this.value" />
                    <div class="debtActionButtons">
                        <button type="button" class="debtBtn debtBtnSage" onclick="submitPayment('${d.clientId}')">Record payment</button>
                        <button type="button" class="debtBtn debtBtnGhost" onclick="closeAction()">X</button>
                    </div>
                </div>`;
        } else if (action === "due") {
            actionsHtml = `
                <div class="debtActionForm">
                    <input type="date" id="draft-${d.clientId}" value="${escapeAttr(APP.draft[d.clientId] || d.dueDate || "")}" oninput="APP.draft['${d.clientId}']=this.value" />
                    <div class="debtActionButtons">
                        <button type="button" class="debtBtn debtBtnAmber" onclick="submitDueDate('${d.clientId}')">Save date</button>
                        <button type="button" class="debtBtn debtBtnGhost" onclick="closeAction()">X</button>
                    </div>
                </div>`;
        } else {
            actionsHtml = `
                <div class="debtActionRow">
                    <button type="button" class="debtBtn debtBtnDark" onclick="openAction('${d.clientId}','note')">Chased today</button>
                    <button type="button" class="debtBtn debtBtnSage" onclick="openAction('${d.clientId}','pay')">Record payment</button>
                    <button type="button" class="debtBtn debtBtnAmber" onclick="openAction('${d.clientId}','due')">${d.dueDate ? "New promised date" : "Set due date"}</button>
                    ${wa ? `<a href="${wa}" target="_blank" rel="noopener noreferrer" class="debtBtn debtBtnWhatsapp">WhatsApp reminder</a>` : ""}
                    ${isLong ? `<button type="button" class="debtBtn debtBtnGhost" onclick="openAccount('${d.clientId}','${escapeAttr(d.clientName)}',${remaining})">View account</button>` : ""}
                    <button type="button" class="debtBtn debtBtnCrimson" onclick="submitDeadDebt('${d.clientId}')">Dead debt</button>
                </div>`;
        }
    } else if (d.status !== "active") {
        actionsHtml = `
            <div class="debtResolvedRow">
                <span class="debtResolvedLabel debtResolvedLabel-${d.status}">${d.status === "paid" ? "Paid" : "Dead debt"}</span>
                ${canEdit ? `<button type="button" class="debtBtn debtBtnGhost" onclick="submitStatus('${d.clientId}','active')">Reopen</button>` : ""}
            </div>`;
    } else if (isLong) {
        actionsHtml = `<div class="debtActionRow"><button type="button" class="debtBtn debtBtnGhost" onclick="openAccount('${d.clientId}','${escapeAttr(d.clientName)}',${remaining})">View account</button></div>`;
    }

    return `
        <div class="debtCard ${d.isAgingShort ? "debtCard-aging" : ""}">
            <div class="debtCardTop">
                <div class="debtBadge ${due.cls}">
                    <span class="debtBadgeNum">${due.diff !== undefined ? (due.diff < 0 ? "+" + Math.abs(due.diff) : due.diff) : "-"}</span>
                    <span class="debtBadgeLabel">${escapeHtml(due.label)}</span>
                </div>
                <div class="debtCardMain">
                    <div class="debtCardHead">
                        <div>
                            <span class="debtTypePill debtTypePill-${d.type.toLowerCase()}">${typePill}</span>
                            ${d.creditor ? `<span class="debtCreditorPill">${escapeHtml(d.creditor)}</span>` : ""}
                            ${d.isAgingShort ? `<div class="debtAgingFlag">Open ${daysBetween(d.dateGiven, todayStr())}d - consider a Daftra invoice</div>` : ""}
                            ${isLong
                                ? `<button type="button" class="debtName" onclick="openAccount('${d.clientId}','${escapeAttr(d.clientName)}',${remaining})">${escapeHtml(d.clientName)}</button>`
                                : `<div class="debtName">${escapeHtml(d.clientName)}</div>`}
                        </div>
                        <div class="debtAmount">
                            <div class="debtAmountValue">${money(remaining)}</div>
                            ${d.amountPaid > 0 ? `<div class="debtAmountSub">of ${money(d.amount)}</div>` : ""}
                        </div>
                    </div>
                    <div class="debtMeta">${metaBits.join(" | ")}</div>
                    ${
                        lastEntry
                            ? `<button type="button" class="debtLastLine" onclick="toggleDebtLog('${d.clientId}')">Last: ${escapeHtml(lastEntry.note)} - ${escapeHtml(lastEntry.actor)}, ${fmtDateTime(lastEntry.time)} ${logOpen ? "^" : "v"}</button>`
                            : ""
                    }
                    ${
                        logOpen
                            ? `<div class="debtLog">${d.log
                                  .slice()
                                  .reverse()
                                  .map((e) => `<div class="debtLogRow"><span class="debtLogTime">${fmtDateTime(e.time)}</span> | ${escapeHtml(e.actor)} - ${escapeHtml(e.note)}</div>`)
                                  .join("")}</div>`
                            : ""
                    }
                    ${actionsHtml}
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

function submitFollowUp(clientId) {
    const note = APP.draft[clientId] || "";
    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to save a follow-up."),
        () => {
            apiCall("addDebtFollowUp", APP.employee.name, APP.employee.pin, clientId, note)
                .then(() => {
                    APP.openAction = null;
                    delete APP.draft[clientId];
                    doSync(true);
                })
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

function submitPayment(clientId) {
    const amount = APP.draft[clientId];
    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to record a payment."),
        () => {
            apiCall("recordDebtPayment", APP.employee.name, APP.employee.pin, clientId, amount)
                .then(() => {
                    APP.openAction = null;
                    delete APP.draft[clientId];
                    doSync(true);
                })
                .catch((err) => {
                    hideLoading();
                    showError(err);
                });
        },
    );
}

function submitDueDate(clientId) {
    const newDate = APP.draft[clientId];
    withOnlineCheck(
        () => showError("You're offline -- connect to the internet to reschedule."),
        () => {
            apiCall("rescheduleDebtDueDate", APP.employee.name, APP.employee.pin, clientId, newDate)
                .then(() => {
                    APP.openAction = null;
                    delete APP.draft[clientId];
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

function submitDeadDebt(clientId) {
    const d = debtsAllList().find((x) => String(x.clientId) === String(clientId));
    const label = d ? `${d.clientName}'s remaining balance of ${money(d.amount - d.amountPaid)}` : "this debt";
    if (!confirm(`Write off ${label} as dead debt?`)) return;
    submitStatus(clientId, "dead");
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
        document.getElementById("newDueDate").value = addDays(todayStr(), 7);
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
    const dueDate = document.getElementById("newDueDate").value;
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
            apiCall("addShortDebt", APP.employee.name, APP.employee.pin, name, amount, phone, dueDate, dateGiven, notes, creditor)
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
        <div class="debtSheetHint">Last ${statement.periodDays} days of activity</div>
        <div class="acctStatementList">${rows || '<div class="emptyState">No activity in the last ' + statement.periodDays + ' days.</div>'}</div>
        ${
            canEdit
                ? `
            <div class="debtLoginLabel">Add payment</div>
            <input type="number" id="acctPayAmount" class="debtLoginInput" placeholder="Amount" />
            <input type="text" id="acctPayNote" class="debtLoginInput" placeholder="Note (optional)" style="margin-top: 8px" />
            <button type="button" class="debtBtn debtBtnSage debtLoginButton" onclick="submitAccountPayment()">Record payment in Daftra</button>
            `
                : ""
        }
    `;
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
                .then(() => {
                    hideLoading();
                    // Optimistic new balance -- doSync() below fetches the
                    // real one right after; this just avoids a flash of
                    // the stale pre-payment figure in the meantime.
                    openAccount(clientId, APP.activeAccount.clientName, APP.activeAccount.balance - Number(amount));
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
    const matches = all.filter((p) => p.name.toLowerCase().includes(query) || (p.sku || "").toLowerCase().includes(query)).slice(0, 30);

    if (matches.length === 0) {
        container.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = "No products match that search.";
        return;
    }

    empty.style.display = "none";
    container.innerHTML = matches
        .map(
            (p) => `
        <button type="button" class="productCard" onclick="openProductHistory('${p.id}','${escapeAttr(p.name)}')">
            <div class="productName">${escapeHtml(p.name)}</div>
            ${p.sku ? `<div class="productSku">${escapeHtml(p.sku)}</div>` : ""}
        </button>`,
        )
        .join("");
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
