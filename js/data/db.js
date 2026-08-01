import { DB_NAME, DB_VERSION } from '../config.js';

/**
 * Thin IndexedDB wrapper.
 *
 * Stores:
 *   tracks  keyPath 'id'    — compact track records, indexed by month and source
 *   months  keyPath 'month' — {month, hash, count} marking a month fully cached
 *   prefs   keyPath 'key'   — {key, value} UI state
 *
 * Every call resolves rather than rejects on failure: the cache is an
 * optimisation, and a browser with IndexedDB disabled or a full quota should
 * fall back to the network rather than break the app.
 */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise(resolve => {
    if (!('indexedDB' in window)) { resolve(null); return; }

    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { resolve(null); return; }

    req.onupgradeneeded = e => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      // v1 stored points as nested arrays and was never released, so there is
      // nothing worth migrating — drop the stores and let them repopulate.
      if (oldVersion > 0 && oldVersion < 2 && db.objectStoreNames.contains('tracks')) {
        db.deleteObjectStore('tracks');
        if (db.objectStoreNames.contains('months')) db.deleteObjectStore('months');
      }

      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('month',  'month');
        s.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains('months')) {
        db.createObjectStore('months', { keyPath: 'month' });
      }
      if (!db.objectStoreNames.contains('prefs')) {
        db.createObjectStore('prefs', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => { console.warn('IndexedDB unavailable:', req.error); resolve(null); };
    req.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror    = () => reject(transaction.error);
    transaction.onabort    = () => reject(transaction.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── Months ────────────────────────────────────────────────────────

/** {month: hash} for every fully cached month. */
export async function cachedMonths() {
  const db = await openDB();
  if (!db) return {};
  try {
    const rows = await request(tx(db, ['months'], 'readonly').objectStore('months').getAll());
    return Object.fromEntries(rows.map(r => [r.month, r.hash]));
  } catch (e) {
    console.warn('Could not read cached months:', e);
    return {};
  }
}

/** Compact track records for one cached month. */
export async function readMonth(month) {
  const db = await openDB();
  if (!db) return null;
  try {
    const store = tx(db, ['tracks'], 'readonly').objectStore('tracks');
    return await request(store.index('month').getAll(month));
  } catch (e) {
    console.warn(`Could not read cached month ${month}:`, e);
    return null;
  }
}

/**
 * Cache one month's tracks, already in cache-record form (see
 * trackModel.toCacheRecord). Returns false if the write failed — the caller
 * still has the data in hand, it just will not be there next time.
 */
export async function writeMonth(month, hash, records) {
  const db = await openDB();
  if (!db) return false;

  try {
    const t      = tx(db, ['tracks', 'months'], 'readwrite');
    const tracks = t.objectStore('tracks');
    for (const rec of records) tracks.put(rec);
    t.objectStore('months').put({ month, hash, count: records.length });
    await done(t);
    return true;
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      console.warn(`Storage quota reached caching ${month}; continuing without a cache.`);
    } else {
      console.warn(`Could not cache ${month}:`, e);
    }
    return false;
  }
}

/** Forget a stale month so it will be refetched. */
export async function evictMonth(month) {
  const db = await openDB();
  if (!db) return;
  try {
    const t      = tx(db, ['tracks', 'months'], 'readwrite');
    const tracks = t.objectStore('tracks');
    const keys   = await request(tracks.index('month').getAllKeys(month));
    for (const key of keys) tracks.delete(key);
    t.objectStore('months').delete(month);
    await done(t);
  } catch (e) {
    console.warn(`Could not evict ${month}:`, e);
  }
}

/** Drop every downloaded month, keeping tracks the user imported themselves. */
export async function clearRemoteCache() {
  const db = await openDB();
  if (!db) return;
  try {
    const t      = tx(db, ['tracks', 'months'], 'readwrite');
    const tracks = t.objectStore('tracks');
    const keys   = await request(tracks.index('source').getAllKeys('remote'));
    for (const key of keys) tracks.delete(key);
    t.objectStore('months').clear();
    await done(t);
  } catch (e) {
    console.warn('Could not clear the cache:', e);
  }
}

// ── Locally imported tracks ───────────────────────────────────────

export async function readLocalTracks() {
  const db = await openDB();
  if (!db) return [];
  try {
    const store = tx(db, ['tracks'], 'readonly').objectStore('tracks');
    return await request(store.index('source').getAll('local'));
  } catch (e) {
    console.warn('Could not read imported tracks:', e);
    return [];
  }
}

export async function writeLocalTrack(record) {
  const db = await openDB();
  if (!db) throw new Error('Local storage is unavailable in this browser.');
  const t = tx(db, ['tracks'], 'readwrite');
  t.objectStore('tracks').put({ ...record, source: 'local' });
  await done(t);
}

export async function deleteTrack(id) {
  const db = await openDB();
  if (!db) return;
  try {
    const t = tx(db, ['tracks'], 'readwrite');
    t.objectStore('tracks').delete(id);
    await done(t);
  } catch (e) {
    console.warn(`Could not delete ${id}:`, e);
  }
}

// ── Preferences ───────────────────────────────────────────────────

export async function readPrefs() {
  const db = await openDB();
  if (!db) return {};
  try {
    const rows = await request(tx(db, ['prefs'], 'readonly').objectStore('prefs').getAll());
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch (e) {
    console.warn('Could not read preferences:', e);
    return {};
  }
}

export async function writePrefs(values) {
  const db = await openDB();
  if (!db) return;
  try {
    const t     = tx(db, ['prefs'], 'readwrite');
    const store = t.objectStore('prefs');
    for (const [key, value] of Object.entries(values)) store.put({ key, value });
    await done(t);
  } catch (e) {
    console.warn('Could not save preferences:', e);
  }
}

// ── Housekeeping ──────────────────────────────────────────────────

/** Rough on-disk usage, or null when the browser will not say. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
