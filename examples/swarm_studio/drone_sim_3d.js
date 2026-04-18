"use strict";
/**
 * drone_sim_3d.js — 3D drone state machine + Reynolds flocking + PID-lite altitude.
 *
 * Extends browser_demo_4/drone_sim.js with:
 *   - z (altitude), vz, az, targetZ axes
 *   - pitch/roll orientation from horizontal velocity
 *   - rotorPhase animation tied to motor thrust
 *   - launchState machine: landed → spooling → taking_off → flying → landing
 *
 * All 2D horizontal physics (Reynolds forces, Hungarian/greedy assignment) are
 * reused verbatim from drone_sim.js.
 */

export { assignFormationTargets, scoreDrone, failDrone, recoverDrone, drainBattery }
  from "./drone_sim.js";
import { assignFormationTargets as _assign2d } from "./drone_sim.js";

// ── 3D Physics Parameters ─────────────────────────────────────────────────────

const GRAVITY        = 0.04;   // px/frame² downward
const LIFT_FORCE     = 0.18;   // max upward acceleration
const Z_DAMPING      = 0.94;   // vertical velocity decay per frame
const LEAN_FACTOR    = 0.10;   // radians of pitch/roll per px/frame speed
const GROUND_EFFECT  = 20;     // px — extra lift when closer than this to ground
const ROTOR_IDLE     = 0.3;    // rad/frame at idle
const ROTOR_FULL     = 1.0;    // rad/frame at full throttle
export const HOVER_HEIGHT_RATIO = 0.30; // fraction of canvasDepth

// ── Drone Construction ────────────────────────────────────────────────────────

/**
 * Create a 3D drone. Extends the base demo_4 drone object.
 * @param {number} id
 * @param {number} x  canvas X (0..canvasW)
 * @param {number} y  canvas Y (0..canvasH)
 */
export function createDrone3d(id, x, y) {
  return {
    // ── Inherited from demo_4 drone ──
    id,
    x, y,
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5,
    ax: 0, ay: 0,
    battery: 80 + Math.random() * 20,
    tier: Math.random() < 0.15 ? 1 : Math.random() < 0.5 ? 2 : 3,
    status: "active",
    targetX: x, targetY: y,
    trail: [],
    safQueue: [],
    score: 0,
    formationDeviation: 0,
    assignedBy: null,

    // ── 3D extensions ──
    z: 0,               // altitude (px, 0 = ground)
    vz: 0,              // vertical velocity
    az: 0,              // vertical acceleration
    targetZ: 0,         // formation target altitude
    pitch: 0,           // lean forward/back (radians)
    roll: 0,            // lean left/right (radians)
    rotorPhase: 0,      // cumulative rotor spin (radians, passed to renderer)
    motorThrust: 0,     // 0=idle…1=full (drives rotor speed)
    launchState: "landed", // "landed"|"spooling"|"taking_off"|"flying"|"landing"
    _spoolTimer: 0,     // frames elapsed in SPOOLING state
  };
}

// ── Physics Step ──────────────────────────────────────────────────────────────

/**
 * Step a single drone's 3D physics.
 * Horizontal forces come from stepDrone() in drone_sim.js.
 * Vertical forces are PID-lite altitude control.
 *
 * @param {object} drone
 * @param {Array}  allDrones
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {number} canvasDepth  — total altitude range in px (world Y range)
 * @param {string} preset       — current formation name (e.g. "text" for tight mode)
 */
export function stepDrone3d(drone, allDrones, canvasW, canvasH, canvasDepth, preset) {
  if (drone.status === "offline") return;
  if (drone.launchState === "landed") return;

  // ── Horizontal physics (reuse Reynolds from drone_sim.js) ─────────────────
  // We call the same Reynolds + formation force logic but can't import stepDrone
  // directly (it modifies drone.x/y). Instead we reimplement the core inline:
  _stepHorizontal(drone, allDrones, canvasW, canvasH, preset);

  // ── Vertical (altitude) PID-lite ──────────────────────────────────────────
  if (drone.launchState === "spooling") {
    // Spin up rotors, stay on ground
    drone._spoolTimer = (drone._spoolTimer || 0) + 1;
    drone.motorThrust = Math.min(1, drone._spoolTimer / 90); // ramp over 1.5s@60fps
    drone.rotorPhase += ROTOR_IDLE + drone.motorThrust * (ROTOR_FULL - ROTOR_IDLE);
    return; // no vertical movement yet
  }

  const zErr  = drone.targetZ - drone.z;
  const ramp  = Math.sign(zErr) * Math.min(Math.abs(zErr) / 60, 1);
  const gEffect = drone.z < GROUND_EFFECT ? (1 - drone.z / GROUND_EFFECT) * 0.06 : 0;
  const zForce  = ramp * LIFT_FORCE;
  drone.az  = zForce - GRAVITY + gEffect;
  drone.vz  = (drone.vz + drone.az) * Z_DAMPING;
  drone.z   = Math.max(0, drone.z + drone.vz);

  // Motor thrust (for rotor spin animation)
  drone.motorThrust = Math.max(0, Math.min(1, (zForce + GRAVITY) / LIFT_FORCE));
  drone.rotorPhase += ROTOR_IDLE + drone.motorThrust * (ROTOR_FULL - ROTOR_IDLE);

  // ── Orientation from horizontal velocity ──────────────────────────────────
  drone.pitch =  drone.vy * LEAN_FACTOR;
  drone.roll  = -drone.vx * LEAN_FACTOR;

  // ── Trail ─────────────────────────────────────────────────────────────────
  drone.trail.push({x: drone.x, y: drone.y, z: drone.z});
  if (drone.trail.length > 12) drone.trail.shift();

  // ── Battery drain ─────────────────────────────────────────────────────────
  if (drone.battery > 0) {
    drone.battery -= 0.003;
    if (drone.battery <= 15) drone.status = "low_battery";
  }

  drone.formationDeviation = Math.hypot(
    drone.x - drone.targetX,
    drone.y - drone.targetY,
    drone.z - drone.targetZ,
  );
}

// ── Horizontal Reynolds (inline from drone_sim.js) ───────────────────────────

const SEP_RADIUS = 28, ALI_RADIUS = 60, COH_RADIUS = 80;
const SEP_WEIGHT = 1.2, ALI_WEIGHT = 0.6, COH_WEIGHT = 0.4, FORM_WEIGHT = 2.2;
const MAX_SPEED  = 3.2, MAX_FORCE = 0.24, DAMPING = 0.96;

function _stepHorizontal(drone, allDrones, canvasW, canvasH, preset) {
  const textMode  = preset === "text";
  const sepRadius = textMode ? 14  : SEP_RADIUS;
  const sepWeight = textMode ? 0.3 : SEP_WEIGHT;
  const aliWeight = textMode ? 0.0 : ALI_WEIGHT;
  const cohWeight = textMode ? 0.0 : COH_WEIGHT;
  const formWeight = textMode ? 4.5 : FORM_WEIGHT;
  const maxSpd    = textMode ? 5.0 : MAX_SPEED;

  const { x, y, vx, vy } = drone;
  const sepN = [], aliN = [], cohN = [];
  for (const o of allDrones) {
    if (o.id === drone.id || o.status === "offline") continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < sepRadius) sepN.push({other: o, d});
    if (d < ALI_RADIUS) aliN.push(o);
    if (d < COH_RADIUS) cohN.push(o);
  }

  let ax = 0, ay = 0;

  if (sepN.length > 0) {
    let sx = 0, sy = 0;
    for (const {other, d} of sepN) {
      const w = (sepRadius - d) / sepRadius;
      sx += (x - other.x) * w; sy += (y - other.y) * w;
    }
    const [nx, ny] = norm2(sx, sy);
    ax += nx * sepWeight * MAX_FORCE; ay += ny * sepWeight * MAX_FORCE;
  }
  if (aliWeight > 0 && aliN.length > 0) {
    let avgVx = 0, avgVy = 0;
    for (const o of aliN) { avgVx += o.vx; avgVy += o.vy; }
    avgVx /= aliN.length; avgVy /= aliN.length;
    const [nx, ny] = norm2(avgVx - vx, avgVy - vy);
    ax += nx * aliWeight * MAX_FORCE; ay += ny * aliWeight * MAX_FORCE;
  }
  if (cohWeight > 0 && cohN.length > 0) {
    let cx = 0, cy = 0;
    for (const o of cohN) { cx += o.x; cy += o.y; }
    cx /= cohN.length; cy /= cohN.length;
    const [nx, ny] = norm2(cx - x, cy - y);
    ax += nx * cohWeight * MAX_FORCE; ay += ny * cohWeight * MAX_FORCE;
  }
  const tdx = drone.targetX - x, tdy = drone.targetY - y;
  const tdist = Math.hypot(tdx, tdy);
  if (tdist > 1) {
    const scale = Math.min(tdist / 60, 1);
    const [nx, ny] = norm2(tdx, tdy);
    ax += nx * formWeight * MAX_FORCE * scale;
    ay += ny * formWeight * MAX_FORCE * scale;
  }

  [drone.ax, drone.ay] = lim2(ax, ay, MAX_FORCE * 4);
  let nvx = vx + drone.ax, nvy = vy + drone.ay;
  [nvx, nvy] = lim2(nvx * DAMPING, nvy * DAMPING, maxSpd);
  drone.vx = nvx; drone.vy = nvy;
  drone.x  = Math.max(2, Math.min(canvasW - 2, x + nvx));
  drone.y  = Math.max(2, Math.min(canvasH - 2, y + nvy));
}

function norm2(vx, vy) { const m = Math.hypot(vx, vy) || 1; return [vx/m, vy/m]; }
function lim2(vx, vy, max) { const m = Math.hypot(vx,vy); return m > max ? [(vx/m)*max, (vy/m)*max] : [vx, vy]; }

// ── 3D Formation Assignment ───────────────────────────────────────────────────

/**
 * Assign 3D formation targets to drones.
 * Uses Hungarian (n < 200) or greedy (n ≥ 200) with 3D Euclidean cost.
 *
 * @param {Array} drones  — drone objects with {x, y, z}
 * @param {Array} targets — {x, y, z} in world pixel space
 */
export function assignFormationTargets3d(drones, targets) {
  const n = drones.length;
  if (n === 0 || targets.length === 0) return;

  let tgts = targets;
  while (tgts.length < n) tgts = tgts.concat(targets);
  tgts = tgts.slice(0, n);

  if (n < 200) {
    _hungarian3d(drones, tgts);
  } else {
    _greedy3d(drones, tgts);
  }
}

function _greedy3d(drones, targets) {
  const used = new Set();
  for (const drone of drones) {
    if (drone.status === "offline") continue;
    let bestIdx = -1, bestDist = Infinity;
    for (let j = 0; j < targets.length; j++) {
      if (used.has(j)) continue;
      const d = Math.hypot(drone.x - targets[j].x, drone.y - targets[j].y, drone.z - targets[j].z);
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }
    if (bestIdx >= 0) {
      drone.targetX = targets[bestIdx].x;
      drone.targetY = targets[bestIdx].y;
      drone.targetZ = targets[bestIdx].z;
      used.add(bestIdx);
    }
  }
}

function _hungarian3d(drones, targets) {
  const n = drones.length;
  const cost = Array.from({length: n}, (_, i) =>
    Array.from({length: n}, (_, j) =>
      Math.hypot(drones[i].x - targets[j].x, drones[i].y - targets[j].y, drones[i].z - targets[j].z)
    )
  );
  const INF = 1e9;
  const u = new Array(n+1).fill(0), v = new Array(n+1).fill(0);
  const p = new Array(n+1).fill(0), way = new Array(n+1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minVal = new Array(n+1).fill(INF), used = new Array(n+1).fill(false);
    do {
      used[j0] = true;
      let i0 = p[j0], delta = INF, j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0-1][j-1] - u[i0] - v[j];
          if (cur < minVal[j]) { minVal[j] = cur; way[j] = j0; }
          if (minVal[j] < delta) { delta = minVal[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minVal[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  for (let j = 1; j <= n; j++) {
    const di = p[j] - 1, ti = j - 1;
    if (di >= 0 && di < drones.length && drones[di].status !== "offline") {
      drones[di].targetX = targets[ti].x;
      drones[di].targetY = targets[ti].y;
      drones[di].targetZ = targets[ti].z;
    }
  }
}

// ── Quaternion from pitch + roll ───────────────────────────────────────────────

/**
 * Convert pitch (rotation about X) and roll (rotation about Z) to a unit quaternion.
 * Returns [x, y, z, w] (Hamilton convention).
 */
export function pitchRollToQuat(pitch, roll) {
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll  / 2), sr = Math.sin(roll  / 2);
  // q = qX(pitch) * qZ(roll)  (local-space combination)
  return [sp * cr, sp * sr, cp * sr, cp * cr];
}
