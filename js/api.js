// ============================================================
// Fetch-based client for the Employee Debts API (a separate, standalone
// Apps Script project -- see that project's Api.gs for the contract).
//
// Sent as Content-Type: text/plain (not application/json) so the request
// stays a CORS "simple request" and the browser skips the preflight
// OPTIONS call, which Apps Script Web Apps can't handle. The server
// parses the body as JSON regardless of the declared content type.
// ============================================================

// This project's Apps Script deployment -- MUST be the versioned
// deployment, not @HEAD. Confirmed 2026-08-21: HEAD only works for the
// developer's own Google account regardless of the "Anyone anonymous"
// webapp setting, so it can't serve employees. Backend changes need
// `clasp deploy -i <this id>` in employee-debts-api to actually reach here.
const API_URL = "https://script.google.com/macros/s/AKfycbx5--YJ4IF6VEQqk14AGB0Pxfnv8mpQbmu_e5iTyebZSQKBg_pD7eP2C79Zdk9nor-zDQ/exec";

function apiCall(action, ...params) {
    return fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, params }),
    })
        .then((r) => r.json())
        .then((result) => {
            if (!result || !result.success) {
                throw new Error((result && result.error) || "Request failed");
            }
            return result.data;
        })
        .catch((err) => {
            // A network-level failure (offline, DNS, etc.) surfaces here as
            // a generic "Failed to fetch" -- give a clearer message.
            if (err instanceof TypeError) {
                throw new Error("Couldn't reach the server. Check your connection and try again.");
            }
            throw err;
        });
}

// navigator.onLine is unreliable (true just means "has a network
// interface", not "can actually reach the internet") -- do a real,
// short-timeout probe against the API before allowing a write action.
function checkOnline(timeoutMs) {
    timeoutMs = timeoutMs || 4000;

    if (!navigator.onLine) return Promise.resolve(false);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(API_URL, { method: "GET", signal: controller.signal, cache: "no-store" })
        .then((r) => {
            clearTimeout(timer);
            return r.ok;
        })
        .catch(() => {
            clearTimeout(timer);
            return false;
        });
}
