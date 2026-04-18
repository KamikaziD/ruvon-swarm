"use strict";
/**
 * learning_loop.js — Self-improving telemetry loop for browser_demo_5.
 *
 * Uses storage.js (IndexedDB) to record performance sessions, analyse
 * deviations, and derive physics tweaks applied on the next launch.
 *
 * Exported API:
 *   startPerformance(preset, droneCount)  → ulid
 *   recordTelemetry(ulid, sab, droneCount, frameIdx)
 *   endPerformance(ulid, sab, droneCount, startMs)
 *   loadAndApplyTweaks(physicsParams)     → summary string
 */

import { ulid, openDB, dbAdd, dbGetByIndex, dbGetRecent, dbMarkApplied } from "./storage.js";

// ── SAB field offsets (must match index.html + physics_worker.js) ─────────────
const SAB_FLOATS  = 16;
const IDX_X       = 0;
const IDX_Y       = 1;
const IDX_Z       = 2;
const IDX_TARGETX = 6;
const IDX_TARGETY = 7;
const IDX_TARGETZ = 8;
const IDX_BATTERY = 12;
const IDX_STATUS  = 14; // f32: 0=active 1=low_battery 2=offline 3=landed

const DEV_THRESHOLD   = 40;    // px avg deviation → FORM_WEIGHT tweak
const BATT_VAR_THRESH = 0.05;  // battery variance → BATTERY_DRAIN tweak
const MAX_TWEAKS      = 3;     // look back N records

// ── Helpers ───────────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return mean(arr.map(v => (v - m) ** 2));
}

function statsFromSAB(sab, droneCount) {
  const f32 = new Float32Array(sab);
  const devs = [], batts = [], zs = [];
  for (let i = 0; i < droneCount; i++) {
    const b = i * SAB_FLOATS;
    const st = f32[b + IDX_STATUS];
    if (st === 2 || st === 3) continue;
    devs.push(Math.hypot(
      f32[b + IDX_X] - f32[b + IDX_TARGETX],
      f32[b + IDX_Y] - f32[b + IDX_TARGETY],
      f32[b + IDX_Z] - f32[b + IDX_TARGETZ],
    ));
    batts.push(f32[b + IDX_BATTERY]);
    zs.push(f32[b + IDX_Z]);
  }
  return { avgDev: mean(devs), avgBattery: mean(batts) / 100, avgZ: mean(zs) };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startPerformance(preset, droneCount) {
  const id = ulid();
  await dbAdd("performances", {
    ulid: id, timestamp: Date.now(),
    preset, drone_count: droneCount,
    duration_ms: 0, avg_deviation: 0, battery_variance: 0,
  });
  return id;
}

export async function recordTelemetry(performanceUlid, sab, droneCount, frameIdx) {
  const { avgDev, avgBattery, avgZ } = statsFromSAB(sab, droneCount);
  await dbAdd("telemetry_batches", {
    ulid: ulid(),
    performance_ulid: performanceUlid,
    frame_idx: frameIdx,
    avg_deviation: avgDev,
    avg_battery: avgBattery,
    avg_z: avgZ,
  }).catch(() => {});
}

export async function endPerformance(performanceUlid, sab, droneCount, startMs) {
  const { avgDev, avgBattery } = statsFromSAB(sab, droneCount);
  try {
    const db = await openDB();
    const tx  = db.transaction("performances", "readwrite");
    const store = tx.objectStore("performances");
    await new Promise((res, rej) => {
      const r = store.get(performanceUlid);
      r.onsuccess = () => {
        const rec = r.result;
        if (rec) {
          rec.duration_ms      = Date.now() - startMs;
          rec.avg_deviation    = avgDev;
          rec.battery_variance = variance([avgBattery]);
          store.put(rec);
        }
        res();
      };
      r.onerror = () => rej(r.error);
    });
  } catch {}
  _analyzePerformance(performanceUlid).catch(() => {});
}

async function _analyzePerformance(performanceUlid) {
  const batches = await dbGetByIndex("telemetry_batches", "performance_ulid", performanceUlid);
  if (batches.length < 3) return;
  const avgDev  = mean(batches.map(b => b.avg_deviation));
  const battVar = variance(batches.map(b => b.avg_battery));
  if (avgDev > DEV_THRESHOLD) {
    await dbAdd("learned_tweaks", {
      ulid: ulid(), performance_ulid: performanceUlid,
      tweak_type: "FORM_WEIGHT", params_json: JSON.stringify({ delta: +0.3 }), applied: false,
    });
  }
  if (battVar > BATT_VAR_THRESH) {
    await dbAdd("learned_tweaks", {
      ulid: ulid(), performance_ulid: performanceUlid,
      tweak_type: "BATTERY_DRAIN", params_json: JSON.stringify({ delta: -0.0005 }), applied: false,
    });
  }
}

export async function loadAndApplyTweaks(physicsParams) {
  const tweaks  = await dbGetRecent("learned_tweaks", MAX_TWEAKS * 2);
  const pending = tweaks.filter(t => !t.applied);
  if (!pending.length) return "No learning data yet";

  let applied = 0;
  for (const tweak of pending.slice(0, MAX_TWEAKS)) {
    const { delta } = JSON.parse(tweak.params_json);
    if (tweak.tweak_type === "FORM_WEIGHT") {
      physicsParams.formWeight = Math.min(6.0, (physicsParams.formWeight ?? 2.2) + delta);
      applied++;
    } else if (tweak.tweak_type === "BATTERY_DRAIN") {
      physicsParams.batteryDrain = Math.max(0.001, (physicsParams.batteryDrain ?? 0.003) + delta);
      applied++;
    }
    await dbMarkApplied(tweak.ulid);
  }
  return applied
    ? `Applied ${applied} tweak${applied > 1 ? "s" : ""} from last ${tweaks.length} run${tweaks.length > 1 ? "s" : ""}`
    : "No new tweaks";
}
