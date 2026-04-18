/**
 * drone_sim.js — Drone state machine + Reynolds flocking + formation math.
 *
 * Runs entirely in the main thread, stepped each animation frame.
 * No LLM, no WebWorker required — pure deterministic simulation.
 *
 * Reynolds forces:
 *   Separation  — avoid crowding neighbours
 *   Alignment   — steer toward average heading of neighbours
 *   Cohesion    — steer toward average position of neighbours
 *   Formation   — steer toward assigned target position
 *
 * Formation assignment:
 *   <200 drones  → Hungarian algorithm (optimal, O(n³))
 *   ≥200 drones  → Greedy nearest-neighbour (O(n²), imperceptible quality diff)
 */

"use strict";

// ---------------------------------------------------------------------------
// Drone constructor
// ---------------------------------------------------------------------------
export function createDrone(id, x, y) {
  return {
    id,
    x,
    y, // canvas position (pixels)
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5,
    ax: 0,
    ay: 0, // accumulated acceleration this frame
    battery: 80 + Math.random() * 20, // 0–100
    tier: Math.random() < 0.15 ? 1 : Math.random() < 0.5 ? 2 : 3,
    status: "active", // "active" | "offline" | "low_battery"
    targetX: x,
    targetY: y, // formation target (canvas pixels)
    trail: [], // last N positions for trail rendering
    safQueue: [], // buffered commands during offline
    score: 0, // last computed S(Vc)
    formationDeviation: 0, // distance from target (pixels)
    assignedBy: null, // pod_id that assigned this target (for overlay)
  };
}

// // ---------------------------------------------------------------------------
// // Reynolds parameters (tunable)
// // ---------------------------------------------------------------------------
// const SEP_RADIUS   = 28;    // pixels — avoid neighbours within this
// const ALI_RADIUS   = 60;    // pixels — align with neighbours within this
// const COH_RADIUS   = 80;    // pixels — cohese with neighbours within this
// const SEP_WEIGHT   = 1.8;
// const ALI_WEIGHT   = 0.6;
// const COH_WEIGHT   = 0.4;
// const FORM_WEIGHT  = 2.2;   // formation attraction (dominant)
// const MAX_SPEED    = 3.2;   // pixels/frame
// const MAX_FORCE    = 0.18;  // pixels/frame²
// const DAMPING      = 0.92;  // velocity damping per frame
// const BATTERY_DRAIN = 0.003; // % per frame when active

// ---------------------------------------------------------------------------
// Reynolds parameters (tuned for stable formations)
// ---------------------------------------------------------------------------
const SEP_RADIUS = 28; // pixels — avoid neighbours within this
const ALI_RADIUS = 60; // pixels — align with neighbours within this
const COH_RADIUS = 80; // pixels — cohese with neighbours within this

// WEIGHTS — adjusted for formation stability
const SEP_WEIGHT = 1.2; // ↓ was 1.8 — let formation dominate
const ALI_WEIGHT = 0.6; // ✅ unchanged
const COH_WEIGHT = 0.4; // ✅ unchanged
const FORM_WEIGHT = 2.2; // ✅ unchanged (now 1.8× stronger than separation)

// DYNAMICS — faster correction, less oscillation
const MAX_SPEED = 3.2; // ✅ unchanged
const MAX_FORCE = 0.24; // ↑ was 0.18 — quicker target correction
const DAMPING = 0.96; // ↑ was 0.92 — faster velocity decay

const BATTERY_DRAIN = 0.003; // ✅ unchanged

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function limit(vx, vy, max) {
  const m = Math.hypot(vx, vy);
  return m > max ? [(vx / m) * max, (vy / m) * max] : [vx, vy];
}

function normalize2(vx, vy) {
  const m = Math.hypot(vx, vy) || 1;
  return [vx / m, vy / m];
}

// ---------------------------------------------------------------------------
// Per-drone physics step
// ---------------------------------------------------------------------------
export function stepDrone(drone, allDrones, canvasW, canvasH, preset) {
  if (drone.status === "offline") return;

  const { x, y, vx, vy } = drone;

  // Text mode: drones pack tightly into letter strokes — standard SEP_RADIUS (28px)
  // is larger than the average inter-drone gap (~11px for 300 drones in text), so
  // every drone pushes every neighbour away, defeating formation attraction.
  // Solution: shrink sep radius, mute flocking, amplify formation pull.
  const textMode = preset === "text";
  const sepRadius = textMode ? 14  : SEP_RADIUS;
  const sepWeight = textMode ? 0.3 : SEP_WEIGHT;
  const aliWeight = textMode ? 0.0 : ALI_WEIGHT;
  const cohWeight = textMode ? 0.0 : COH_WEIGHT;
  const formWeight = textMode ? 4.5 : FORM_WEIGHT;
  const maxSpd    = textMode ? 5.0 : MAX_SPEED;

  // Build neighbour lists
  const sepNeighbours = [],
    aliNeighbours = [],
    cohNeighbours = [];
  for (const other of allDrones) {
    if (other.id === drone.id || other.status === "offline") continue;
    const d = dist(drone, other);
    if (d < sepRadius) sepNeighbours.push({ other, d });
    if (d < ALI_RADIUS) aliNeighbours.push(other);
    if (d < COH_RADIUS) cohNeighbours.push(other);
  }

  let ax = 0,
    ay = 0;

  // 1. Separation — steer away from too-close neighbours
  if (sepNeighbours.length > 0) {
    let sx = 0,
      sy = 0;
    for (const { other, d } of sepNeighbours) {
      const weight = (sepRadius - d) / sepRadius; // stronger when closer
      sx += (x - other.x) * weight;
      sy += (y - other.y) * weight;
    }
    const [nx, ny] = normalize2(sx, sy);
    ax += nx * sepWeight * MAX_FORCE;
    ay += ny * sepWeight * MAX_FORCE;
  }

  // 2. Alignment — steer toward average velocity of neighbours
  if (aliWeight > 0 && aliNeighbours.length > 0) {
    let avgVx = 0,
      avgVy = 0;
    for (const o of aliNeighbours) {
      avgVx += o.vx;
      avgVy += o.vy;
    }
    avgVx /= aliNeighbours.length;
    avgVy /= aliNeighbours.length;
    const [nvx, nvy] = normalize2(avgVx - vx, avgVy - vy);
    ax += nvx * aliWeight * MAX_FORCE;
    ay += nvy * aliWeight * MAX_FORCE;
  }

  // 3. Cohesion — steer toward centre of mass of neighbours
  if (cohWeight > 0 && cohNeighbours.length > 0) {
    let cx = 0,
      cy = 0;
    for (const o of cohNeighbours) {
      cx += o.x;
      cy += o.y;
    }
    cx /= cohNeighbours.length;
    cy /= cohNeighbours.length;
    const [nx, ny] = normalize2(cx - x, cy - y);
    ax += nx * cohWeight * MAX_FORCE;
    ay += ny * cohWeight * MAX_FORCE;
  }

  // 4. Formation attraction — steer toward assigned target
  const tdx = drone.targetX - x,
    tdy = drone.targetY - y;
  const tdist = Math.hypot(tdx, tdy);
  if (tdist > 1) {
    const scale = Math.min(tdist / 60, 1); // ramp up force with distance
    const [nx, ny] = normalize2(tdx, tdy);
    ax += nx * formWeight * MAX_FORCE * scale;
    ay += ny * formWeight * MAX_FORCE * scale;
  }

  // Clamp total acceleration
  [drone.ax, drone.ay] = limit(ax, ay, MAX_FORCE * 4);

  // Integrate velocity
  let nvx = vx + drone.ax,
    nvy = vy + drone.ay;
  [nvx, nvy] = limit(nvx * DAMPING, nvy * DAMPING, maxSpd);
  drone.vx = nvx;
  drone.vy = nvy;

  // Integrate position
  drone.x = Math.max(2, Math.min(canvasW - 2, x + nvx));
  drone.y = Math.max(2, Math.min(canvasH - 2, y + nvy));

  // Update trail (keep last 12 positions)
  drone.trail.push({ x: drone.x, y: drone.y });
  if (drone.trail.length > 12) drone.trail.shift();

  // Battery drain
  if (drone.battery > 0) {
    drone.battery -= BATTERY_DRAIN;
    if (drone.battery <= 15) drone.status = "low_battery";
  }

  // Formation deviation
  drone.formationDeviation = Math.hypot(
    drone.x - drone.targetX,
    drone.y - drone.targetY,
  );
}

// ---------------------------------------------------------------------------
// Formation assignment
// ---------------------------------------------------------------------------

/**
 * Assign formation targets to drones.
 * Uses Hungarian algorithm for n < 200, greedy nearest-neighbour otherwise.
 *
 * @param {Array}  drones   — array of drone objects (with .x, .y)
 * @param {Array}  targets  — array of {x, y} in canvas pixel space
 */
export function assignFormationTargets(drones, targets) {
  const n = drones.length;
  if (n === 0 || targets.length === 0) return;

  // Pad or trim targets to match drone count
  let tgts = targets;
  while (tgts.length < n) tgts = tgts.concat(targets);
  tgts = tgts.slice(0, n);

  if (n < 200) {
    hungarianAssign(drones, tgts);
  } else {
    greedyAssign(drones, tgts);
  }
}

/** Greedy nearest-neighbour assignment — O(n²) */
function greedyAssign(drones, targets) {
  const used = new Set();
  for (const drone of drones) {
    if (drone.status === "offline") continue;
    let bestIdx = -1,
      bestDist = Infinity;
    for (let j = 0; j < targets.length; j++) {
      if (used.has(j)) continue;
      const d = Math.hypot(drone.x - targets[j].x, drone.y - targets[j].y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      drone.targetX = targets[bestIdx].x;
      drone.targetY = targets[bestIdx].y;
      used.add(bestIdx);
    }
  }
}

/**
 * Hungarian algorithm (Munkres) — O(n³), optimal for n < 200.
 * Minimises total distance between drones and targets.
 */
function hungarianAssign(drones, targets) {
  const n = drones.length;
  // Cost matrix: cost[i][j] = distance from drone i to target j
  const cost = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      Math.hypot(drones[i].x - targets[j].x, drones[i].y - targets[j].y),
    ),
  );

  // Munkres algorithm
  const INF = 1e9;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0); // target assigned to each drone row
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minVal = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      let i0 = p[j0],
        delta = INF,
        j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minVal[j]) {
            minVal[j] = cur;
            way[j] = j0;
          }
          if (minVal[j] < delta) {
            delta = minVal[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minVal[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  // Apply assignment: p[j] = drone index (1-based) for target j (1-based)
  for (let j = 1; j <= n; j++) {
    const droneIdx = p[j] - 1;
    const targetIdx = j - 1;
    if (
      droneIdx >= 0 &&
      droneIdx < drones.length &&
      drones[droneIdx].status !== "offline"
    ) {
      drones[droneIdx].targetX = targets[targetIdx].x;
      drones[droneIdx].targetY = targets[targetIdx].y;
    }
  }
}

// ---------------------------------------------------------------------------
// Compute S(Vc) score for a drone (mirrors RUVON formula)
// ---------------------------------------------------------------------------
export function scoreDrone(drone) {
  const C =
    drone.status === "offline" ? 0 : drone.status === "low_battery" ? 0.3 : 1.0;
  const H = 1; // 1-hop always in local mesh
  const U = Math.min(drone.battery / 100, 1);
  const P = Math.max(1 - drone.safQueue.length / 5, 0);
  return 0.5 * C + 0.15 * (1 / Math.max(H, 1)) + 0.25 * U + 0.1 * P;
}

// ---------------------------------------------------------------------------
// Simulate failure / recovery
// ---------------------------------------------------------------------------
export function failDrone(drone) {
  drone.status = "offline";
  drone.vx = 0;
  drone.vy = 0;
}

export function recoverDrone(drone) {
  if (drone.status === "offline") {
    drone.status = drone.battery > 15 ? "active" : "low_battery";
  }
}

export function drainBattery(drone, amount) {
  drone.battery = Math.max(0, drone.battery - amount);
  if (drone.battery <= 15) drone.status = "low_battery";
}
