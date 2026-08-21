// ============================================================
// Minimal IndexedDB key-value wrapper for the offline sync cache. Plain
// IndexedDB rather than localStorage -- the product catalog can get large
// enough that localStorage's ~5MB/synchronous-API limits are a real risk.
// ============================================================

const DB_NAME = "employee-debts-db";
const DB_VERSION = 1;
const STORE = "cache";

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE);
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbGet(key) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readonly");
                const req = tx.objectStore(STORE).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            }),
    );
}

function dbSet(key, value) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }),
    );
}
