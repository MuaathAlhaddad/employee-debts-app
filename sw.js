// Caches the app shell (HTML/CSS/JS/icons) so the app can load offline.
// Deliberately does NOT touch calls to the Employee Debts API (a
// different origin, script.google.com) -- those are handled by the app's
// own IndexedDB cache in js/db.js, not the service worker.
//
// BUMP THIS NUMBER on every push that changes index.html/css/js -- it's
// the only thing that makes an already-installed phone drop its stale
// cached shell and fetch the new files. Forgetting to bump it means the
// update silently never reaches anyone who already has the app installed
// (confirmed real gotcha, 2026-08-25).
const CACHE_NAME = "employee-debts-shell-v22";

const SHELL_FILES = [
    "./",
    "./index.html",
    "./manifest.json",
    "./css/app.css",
    "./js/db.js",
    "./js/api.js",
    "./js/app.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(
                // cache.addAll()'s default fetches don't bypass the
                // browser's ordinary HTTP cache (or an intermediate CDN
                // edge's) -- confirmed 2026-08-26 as a real bug: a stale
                // response served just once here gets baked into this
                // cache PERMANENTLY, since the fetch handler below never
                // revalidates once there's a cache hit. { cache: "reload" }
                // forces every install-time fetch to actually hit the
                // origin instead of trusting any cached copy in between.
                SHELL_FILES.map((url) => fetch(url, { cache: "reload" }).then((response) => cache.put(url, response))),
            ),
        ),
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Only handle our own static files -- let API calls (a different
    // origin) and anything else pass through to the network untouched.
    if (url.origin !== self.location.origin || event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;

            return fetch(event.request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    return response;
                })
                .catch(() => cached);
        }),
    );
});
