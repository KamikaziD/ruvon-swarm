"use strict";
/**
 * storage.js — ULID generator + IndexedDB helpers for the learning loop.
 *
 * IndexedDB schema (DB: ruvon_swarm_studio, version 1):
 *   performances      — one record per formation run
 *   telemetry_batches — 5Hz samples during a run
 *   learned_tweaks    — parameter adjustments from analysis
 */

// ── ULID ──────────────────────────────────────────────────────────────────────

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENC_LEN  = ENCODING.length;
let _lastMs = 0, _lastRand = new Uint8Array(10);

/**
 * Generate a monotonic ULID (26-char, time-sortable unique ID).
 * Monotonic within the same millisecond by incrementing the random part.
 */
export function ulid() {
  const now = Date.now();
  if (now === _lastMs) {
    incrementRand(_lastRand);
  } else {
    _lastMs = now;
    crypto.getRandomValues(_lastRand);
  }
  return encodeTime(now) + encodeRand(_lastRand);
}

function encodeTime(ms) {
  let t = ms, result = "";
  for (let i = 9; i >= 0; i--) {
    result = ENCODING[t % ENC_LEN] + result;
    t = Math.floor(t / ENC_LEN);
  }
  return result;
}

function encodeRand(rand) {
  let result = "";
  for (let i = 0; i < 10; i++) result += ENCODING[rand[i] & 0x1f];
  return result;
}

function incrementRand(rand) {
  for (let i = rand.length - 1; i >= 0; i--) {
    if (rand[i] < 0x1f) { rand[i]++; return; }
    rand[i] = 0;
  }
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────

const DB_NAME    = "ruvon_swarm_studio";
const DB_VERSION = 1;
let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("performances")) {
        const ps = db.createObjectStore("performances", { keyPath: "ulid" });
        ps.createIndex("timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("telemetry_batches")) {
        const ts = db.createObjectStore("telemetry_batches", { keyPath: "ulid" });
        ts.createIndex("performance_ulid", "performance_ulid");
      }
      if (!db.objectStoreNames.contains("learned_tweaks")) {
        const lt = db.createObjectStore("learned_tweaks", { keyPath: "ulid" });
        lt.createIndex("performance_ulid", "performance_ulid");
        lt.createIndex("applied", "applied");
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

export async function dbAdd(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Get N most recent records from a store (sorted by ULID key, newest first). */
export async function dbGetRecent(storeName, n) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const results = [];
    const req = db.transaction(storeName, "readonly")
                  .objectStore(storeName)
                  .openCursor(null, "prev");
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < n) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dbMarkApplied(tweakUlid) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction("learned_tweaks", "readwrite");
    const store = tx.objectStore("learned_tweaks");
    const getR  = store.get(tweakUlid);
    getR.onsuccess = () => {
      const rec = getR.result;
      if (rec) { rec.applied = true; store.put(rec); }
      resolve();
    };
    getR.onerror = () => reject(getR.error);
  });
}
