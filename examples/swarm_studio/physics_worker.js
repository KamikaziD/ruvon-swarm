"use strict";
/**
 * physics_worker.js — SharedArrayBuffer physics worker for browser_demo_5.
 *
 * Each worker is responsible for a contiguous slice of drones [droneStart, droneStart+droneCount).
 * Physics (Reynolds flocking + PID altitude) runs entirely in this worker.
 * Results are written directly to the SAB — no data copying across the boundary.
 *
 * SAB layout per drone (16 × f32 = 64 bytes):
 *   [0]x [1]y [2]z [3]vx [4]vy [5]vz
 *   [6]targetX [7]targetY [8]targetZ
 *   [9]pitch [10]roll [11]rotorPhase
 *   [12]battery [13]motorThrust [14]status_f32 [15]tier_f32
 *
 * Messages IN:
 *   {type:"INIT",  sab, droneStart, droneCount, workerIdx, canvasW, canvasH, canvasDepth}
 *   {type:"STEP",  preset}   — run one physics frame, then reply FRAME_DONE
 *   {type:"RESET"} — re-land all drones in our slice
 *
 * Messages OUT:
 *   {type:"FRAME_DONE", workerIdx}
 */

/* global self */

// ── SAB field indices ─────────────────────────────────────────────────────────
const F  = 16;
const IX = {
  X:0, Y:1, Z:2, VX:3, VY:4, VZ:5,
  TX:6, TY:7, TZ:8, PITCH:9, ROLL:10,
  ROTOR:11, BATT:12, THRUST:13, STATUS:14, TIER:15,
};

// Status codes (f32)
const ST_ACTIVE     = 0;
const ST_LOW_BAT    = 1;
const ST_OFFLINE    = 2;
const ST_LANDED     = 3;
const ST_SPOOLING   = 4; // extension: spooling (pre-takeoff)
const ST_TAKING_OFF = 5;
const ST_LANDING    = 6;

// ── Physics constants ─────────────────────────────────────────────────────────
const GRAVITY       = 0.04;
const LIFT_FORCE    = 0.18;
const Z_DAMPING     = 0.94;
const LEAN_FACTOR   = 0.10;
const GROUND_EFFECT = 20;
const ROTOR_IDLE    = 0.3;
const ROTOR_FULL    = 1.0;
const BATT_DRAIN    = 0.003;

const SEP_RADIUS = 28, ALI_RADIUS = 60, COH_RADIUS = 80;
const SEP_WEIGHT = 1.2, ALI_WEIGHT = 0.6, COH_WEIGHT = 0.4, FORM_WEIGHT = 2.2;
const MAX_SPEED  = 3.2, MAX_FORCE = 0.24, DAMPING = 0.96;

// ── State ─────────────────────────────────────────────────────────────────────
let sab        = null;
let f32        = null;
let droneStart = 0;
let droneCount = 0;
let workerIdx  = 0;
let canvasW    = 800;
let canvasH    = 600;
let canvasDepth = 600;
// Spool timers per drone (not in SAB — worker-local ephemeral state)
const spoolTimers = new Float32Array(256);

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm2(vx, vy) {
  const m = Math.hypot(vx, vy) || 1;
  return [vx/m, vy/m];
}
function lim2(vx, vy, max) {
  const m = Math.hypot(vx, vy);
  return m > max ? [(vx/m)*max, (vy/m)*max] : [vx, vy];
}

/** Read all drone state from SAB into a lightweight object array (for Reynolds neighbors). */
function readAllDrones(totalDrones) {
  const out = [];
  for (let i = 0; i < totalDrones; i++) {
    const b = i * F;
    out.push({
      idx:    i,
      x:      f32[b+IX.X],
      y:      f32[b+IX.Y],
      vx:     f32[b+IX.VX],
      vy:     f32[b+IX.VY],
      status: f32[b+IX.STATUS],
    });
  }
  return out;
}

/**
 * Step horizontal physics (Reynolds + formation steering) for one drone.
 * Reads neighbours from allDrones snapshot, writes back to SAB.
 */
function stepHorizontal(localIdx, allDrones, preset) {
  const i   = droneStart + localIdx;
  const b   = i * F;

  const st  = f32[b+IX.STATUS];
  if (st === ST_OFFLINE) return;

  const textMode = preset === "text";
  const sepR  = textMode ? 14   : SEP_RADIUS;
  const sepW  = textMode ? 0.3  : SEP_WEIGHT;
  const aliW  = textMode ? 0.0  : ALI_WEIGHT;
  const cohW  = textMode ? 0.0  : COH_WEIGHT;
  const frmW  = textMode ? 4.5  : FORM_WEIGHT;
  const maxS  = textMode ? 5.0  : MAX_SPEED;

  const x = f32[b+IX.X], y = f32[b+IX.Y];
  const vx = f32[b+IX.VX], vy = f32[b+IX.VY];

  const sepN = [], aliN = [], cohN = [];
  for (const o of allDrones) {
    if (o.idx === i || o.status === ST_OFFLINE) continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < sepR)       sepN.push({other:o, d});
    if (d < ALI_RADIUS) aliN.push(o);
    if (d < COH_RADIUS) cohN.push(o);
  }

  let ax = 0, ay = 0;

  if (sepN.length > 0) {
    let sx = 0, sy = 0;
    for (const {other, d} of sepN) {
      const w = (sepR - d) / sepR;
      sx += (x - other.x) * w; sy += (y - other.y) * w;
    }
    const [nx, ny] = norm2(sx, sy);
    ax += nx * sepW * MAX_FORCE; ay += ny * sepW * MAX_FORCE;
  }
  if (aliW > 0 && aliN.length > 0) {
    let avgVx = 0, avgVy = 0;
    for (const o of aliN) { avgVx += o.vx; avgVy += o.vy; }
    avgVx /= aliN.length; avgVy /= aliN.length;
    const [nx, ny] = norm2(avgVx - vx, avgVy - vy);
    ax += nx * aliW * MAX_FORCE; ay += ny * aliW * MAX_FORCE;
  }
  if (cohW > 0 && cohN.length > 0) {
    let cx = 0, cy = 0;
    for (const o of cohN) { cx += o.x; cy += o.y; }
    cx /= cohN.length; cy /= cohN.length;
    const [nx, ny] = norm2(cx - x, cy - y);
    ax += nx * cohW * MAX_FORCE; ay += ny * cohW * MAX_FORCE;
  }

  const tdx = f32[b+IX.TX] - x, tdy = f32[b+IX.TY] - y;
  const tdist = Math.hypot(tdx, tdy);
  if (tdist > 1) {
    const scale = Math.min(tdist / 60, 1);
    const [nx, ny] = norm2(tdx, tdy);
    ax += nx * frmW * MAX_FORCE * scale;
    ay += ny * frmW * MAX_FORCE * scale;
  }

  const [clampedAx, clampedAy] = lim2(ax, ay, MAX_FORCE * 4);
  let nvx = vx + clampedAx, nvy = vy + clampedAy;
  [nvx, nvy] = lim2(nvx * DAMPING, nvy * DAMPING, maxS);
  f32[b+IX.VX] = nvx;
  f32[b+IX.VY] = nvy;
  f32[b+IX.X]  = Math.max(2, Math.min(canvasW - 2, x + nvx));
  f32[b+IX.Y]  = Math.max(2, Math.min(canvasH - 2, y + nvy));
}

/** Step vertical (altitude PID-lite) physics for one drone. */
function stepVertical(localIdx) {
  const i   = droneStart + localIdx;
  const b   = i * F;
  const st  = f32[b+IX.STATUS];

  if (st === ST_OFFLINE || st === ST_LANDED) {
    // Landed: zero velocity, stay on ground
    f32[b+IX.VZ] = 0;
    f32[b+IX.Z]  = 0;
    f32[b+IX.THRUST] = 0;
    f32[b+IX.ROTOR] += ROTOR_IDLE * 0.05;
    return;
  }

  if (st === ST_SPOOLING) {
    spoolTimers[localIdx] = (spoolTimers[localIdx] || 0) + 1;
    const thrust = Math.min(1, spoolTimers[localIdx] / 90);
    f32[b+IX.THRUST] = thrust;
    f32[b+IX.ROTOR] += ROTOR_IDLE + thrust * (ROTOR_FULL - ROTOR_IDLE);
    // After 90 frames (~1.5s), transition to TAKING_OFF
    if (spoolTimers[localIdx] >= 90) {
      f32[b+IX.STATUS] = ST_TAKING_OFF;
      spoolTimers[localIdx] = 0;
    }
    return;
  }

  const z    = f32[b+IX.Z];
  const vz   = f32[b+IX.VZ];
  const tz   = f32[b+IX.TZ];

  const zErr  = tz - z;
  const ramp  = Math.sign(zErr) * Math.min(Math.abs(zErr) / 60, 1);
  const gEff  = z < GROUND_EFFECT ? (1 - z / GROUND_EFFECT) * 0.06 : 0;
  const zForce = ramp * LIFT_FORCE;
  const az    = zForce - GRAVITY + gEff;
  const nvz   = (vz + az) * Z_DAMPING;
  const nz    = Math.max(0, z + nvz);

  f32[b+IX.VZ] = nvz;
  f32[b+IX.Z]  = nz;

  const thrust = Math.max(0, Math.min(1, (zForce + GRAVITY) / LIFT_FORCE));
  f32[b+IX.THRUST] = thrust;
  f32[b+IX.ROTOR] += ROTOR_IDLE + thrust * (ROTOR_FULL - ROTOR_IDLE);

  // Orientation from horizontal velocity
  f32[b+IX.PITCH] =  f32[b+IX.VY] * LEAN_FACTOR;
  f32[b+IX.ROLL]  = -f32[b+IX.VX] * LEAN_FACTOR;

  // State transitions
  if (st === ST_TAKING_OFF && nz >= tz * 0.95) {
    f32[b+IX.STATUS] = ST_ACTIVE;
  }
  if (st === ST_LANDING && nz <= 2) {
    f32[b+IX.STATUS] = ST_LANDED;
    f32[b+IX.TZ] = 0;
  }

  // Battery
  const batt = f32[b+IX.BATT];
  if (batt > 0) {
    f32[b+IX.BATT] = batt - BATT_DRAIN;
    if (batt - BATT_DRAIN <= 15 && f32[b+IX.STATUS] === ST_ACTIVE) {
      f32[b+IX.STATUS] = ST_LOW_BAT;
    }
  }
}

// ── Frame step ────────────────────────────────────────────────────────────────

let totalDrones = 64; // updated on INIT

function stepFrame(preset) {
  const allDrones = readAllDrones(totalDrones);
  for (let li = 0; li < droneCount; li++) {
    const globalI = droneStart + li;
    const st = f32[globalI * F + IX.STATUS];
    if (st !== ST_OFFLINE && st !== ST_LANDED && st !== ST_SPOOLING) {
      stepHorizontal(li, allDrones, preset);
    }
    stepVertical(li);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = (e) => {
  const { type } = e.data;

  if (type === "INIT") {
    ({ sab, droneStart, droneCount, workerIdx, canvasW, canvasH, canvasDepth } = e.data);
    totalDrones = e.data.totalDrones ?? 64;
    f32 = new Float32Array(sab);
    self.postMessage({ type: "READY", workerIdx });
  }

  else if (type === "STEP") {
    stepFrame(e.data.preset ?? "ruvon3d");
    self.postMessage({ type: "FRAME_DONE", workerIdx });
  }

  else if (type === "RESET") {
    if (!f32) return;
    for (let li = 0; li < droneCount; li++) {
      const b = (droneStart + li) * F;
      f32[b+IX.STATUS] = ST_LANDED;
      f32[b+IX.Z]      = 0;
      f32[b+IX.VZ]     = 0;
      f32[b+IX.THRUST] = 0;
      spoolTimers[li]  = 0;
    }
    self.postMessage({ type: "FRAME_DONE", workerIdx });
  }

  else if (type === "TOTAL_DRONES") {
    totalDrones = e.data.count;
  }
};
