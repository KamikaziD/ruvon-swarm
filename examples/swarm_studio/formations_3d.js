"use strict";
/**
 * formations_3d.js — 3D formation library for browser_demo_5.
 *
 * All functions return Array<{x, y, z}> in normalized [0, 1]³ space.
 * The main thread scales to world pixel space:
 *   worldX = (p.x - 0.5) * canvasW   → drone.targetX
 *   worldY = p.z * canvasDepth        → drone.targetZ (altitude)
 *   worldZ = (p.y - 0.5) * canvasH   → drone.targetY
 *
 * New 3D presets: sphere, helix, torus, wave, vortex, dna, cube
 * Also exports: ruvon3dFormation (2D ruvon extruded to 3D slab)
 */

import { getFormationTargets, mulberry32 } from "./formations.js";

// Module-level RNG — swapped to a seeded instance inside getFormationTargets3d()
let _rng3d = Math.random;

// ── Helpers ────────────────────────────────────────────────────────────────────

function fillToCount(pts, n, jitter = 0.005) {
  if (pts.length === 0) return Array.from({length: n}, () => ({x: 0.5, y: 0.5, z: 0.5}));
  if (pts.length >= n) {
    const step = pts.length / n;
    return Array.from({length: n}, (_, i) => pts[Math.floor(i * step)]);
  }
  const out = [...pts];
  while (out.length < n) {
    const src = pts[Math.floor(_rng3d() * pts.length)];
    out.push({
      x: src.x + (_rng3d() - 0.5) * jitter,
      y: src.y + (_rng3d() - 0.5) * jitter,
      z: src.z + (_rng3d() - 0.5) * jitter,
    });
  }
  return out;
}

function sampleCurve3d(fn, n, tMin = 0, tMax = 1) {
  return Array.from({length: n}, (_, i) => fn(tMin + (i / (n - 1)) * (tMax - tMin)));
}

// ── 3D Formation Functions ─────────────────────────────────────────────────────

/**
 * Sphere — Fibonacci lattice on unit sphere.
 * Result fills roughly a sphere centered at (0.5, 0.5, 0.5) with radius 0.45.
 */
export function sphereFormation(n) {
  const golden = Math.PI * (Math.sqrt(5) - 1); // golden angle
  return Array.from({length: n}, (_, i) => {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    return {
      x: 0.5 + r * Math.cos(theta) * 0.45,
      y: 0.5 + r * Math.sin(theta) * 0.45,
      z: 0.5 + y * 0.45,
    };
  });
}

/**
 * Helix — multi-strand parametric helix (DNA-style).
 * strands: 1 = single helix, 2 = double (default), 3 = triple.
 */
export function helixFormation(n, strands = 2) {
  const pts = [];
  const turns = 3;
  for (let i = 0; i < n; i++) {
    const s = i % strands;
    const t = (Math.floor(i / strands) / Math.ceil(n / strands)) * turns * Math.PI * 2;
    const phaseOffset = (s / strands) * Math.PI * 2;
    pts.push({
      x: 0.5 + 0.38 * Math.cos(t + phaseOffset),
      y: 0.5 + 0.38 * Math.sin(t + phaseOffset),
      z: 0.1 + (t / (turns * Math.PI * 2)) * 0.8,
    });
  }
  return pts;
}

/**
 * DNA — double helix with connecting rungs.
 */
export function dnaFormation(n) {
  const strand = Math.ceil(n * 0.7);
  const rungs  = n - strand;
  const pts = [];
  // Two strands
  const turns = 4;
  for (let i = 0; i < strand; i++) {
    const s = i % 2;
    const t = (Math.floor(i / 2) / Math.ceil(strand / 2)) * turns * Math.PI * 2;
    pts.push({
      x: 0.5 + 0.35 * Math.cos(t + s * Math.PI),
      y: 0.5 + 0.35 * Math.sin(t + s * Math.PI),
      z: 0.1 + (t / (turns * Math.PI * 2)) * 0.8,
    });
  }
  // Connecting rungs
  for (let i = 0; i < rungs; i++) {
    const t = (i / rungs) * turns * Math.PI * 2;
    const z = 0.1 + (t / (turns * Math.PI * 2)) * 0.8;
    const tt = (i % 3) / 3;
    pts.push({
      x: 0.5 + (0.35 - 0.7 * tt) * Math.cos(t),
      y: 0.5 + (0.35 - 0.7 * tt) * Math.sin(t),
      z,
    });
  }
  return fillToCount(pts, n, 0.003);
}

/**
 * Torus — parametric donut shape.
 */
export function torusFormation(n) {
  const R = 0.32;  // major radius
  const r = 0.12;  // minor radius
  return Array.from({length: n}, (_, i) => {
    const u = (i / n) * Math.PI * 2;
    const v = ((i * 7) % n / n) * Math.PI * 2; // stagger v for coverage
    return {
      x: 0.5 + (R + r * Math.cos(v)) * Math.cos(u),
      y: 0.5 + (R + r * Math.cos(v)) * Math.sin(u),
      z: 0.5 + r * Math.sin(v),
    };
  });
}

/**
 * Wave — sinusoidal surface (drones ride a wave across XY plane).
 */
export function waveFormation(n) {
  const cols = Math.ceil(Math.sqrt(n * 1.5));
  const rows = Math.ceil(n / cols);
  const pts = [];
  for (let iy = 0; iy < rows && pts.length < n; iy++) {
    for (let ix = 0; ix < cols && pts.length < n; ix++) {
      const x = ix / (cols - 1);
      const y = iy / (rows - 1);
      const z = 0.35 + 0.25 * Math.sin((x * 4 + y * 2) * Math.PI);
      pts.push({x: 0.1 + x * 0.8, y: 0.1 + y * 0.8, z});
    }
  }
  return fillToCount(pts, n, 0.005);
}

/**
 * Vortex — spinning funnel / tornado shape.
 */
export function vortexFormation(n) {
  return Array.from({length: n}, (_, i) => {
    const t   = i / n;
    const z   = t;                                // 0 = top, 1 = base
    const r   = 0.05 + z * 0.42;                 // radius grows with z
    const theta = t * Math.PI * 12;               // 6 full turns
    return {
      x: 0.5 + r * Math.cos(theta),
      y: 0.5 + r * Math.sin(theta),
      z: 0.9 - z * 0.8,                          // flip so top is high
    };
  });
}

/**
 * Cube — wireframe edges of a cube.
 */
export function cubeFormation(n) {
  const edges = [
    [[0,0,0],[1,0,0]], [[1,0,0],[1,1,0]], [[1,1,0],[0,1,0]], [[0,1,0],[0,0,0]],
    [[0,0,1],[1,0,1]], [[1,0,1],[1,1,1]], [[1,1,1],[0,1,1]], [[0,1,1],[0,0,1]],
    [[0,0,0],[0,0,1]], [[1,0,0],[1,0,1]], [[1,1,0],[1,1,1]], [[0,1,0],[0,1,1]],
  ];
  const perEdge = Math.ceil(n / edges.length);
  const pts = [];
  for (const [a, b] of edges) {
    for (let i = 0; i < perEdge; i++) {
      const t = i / (perEdge - 1 || 1);
      pts.push({
        x: 0.1 + (a[0] + (b[0]-a[0]) * t) * 0.8,
        y: 0.1 + (a[1] + (b[1]-a[1]) * t) * 0.8,
        z: 0.1 + (a[2] + (b[2]-a[2]) * t) * 0.8,
      });
    }
  }
  return fillToCount(pts, n, 0.003);
}

/**
 * Ruvon 3D — the iconic "R" extruded to a 3D slab.
 * Used as the startup rotating formation.
 * This returns the BASE points (no rotation applied here).
 * Main thread applies Y-axis rotation each frame for the spinning effect.
 */
export function ruvon3dFormation(n) {
  const flat = getFormationTargets("ruvon", n); // normalized [0,1]² points
  const depth = 0.06; // ±depth/2 in z
  const out = [];
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i];
    const zOffset = (i % 3 === 0) ? -depth / 2 : (i % 3 === 1) ? 0 : depth / 2;
    out.push({
      x: p.x,
      y: p.y,
      z: 0.5 + zOffset,
    });
  }
  return fillToCount(out, n, 0.002);
}

// ── Rotate about Y axis (for spinning R) ──────────────────────────────────────

/**
 * Apply Y-axis rotation to a set of 3D points (centered at 0.5, 0.5, 0.5).
 * Returns new Array<{x, y, z}>.
 */
export function rotateAboutY(pts, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return pts.map(p => {
    const dx = p.x - 0.5, dz = p.z - 0.5;
    return {
      x: 0.5 + dx * cos - dz * sin,
      y: p.y,
      z: 0.5 + dx * sin + dz * cos,
    };
  });
}

// ── Registry ───────────────────────────────────────────────────────────────────

export const PRESETS_3D = {
  sphere:  sphereFormation,
  helix:   helixFormation,
  dna:     dnaFormation,
  torus:   torusFormation,
  wave:    waveFormation,
  vortex:  vortexFormation,
  cube:    cubeFormation,
  ruvon3d: ruvon3dFormation,
};

/**
 * Get 3D formation targets (normalized [0,1]³).
 *
 * When called with start/end/seed (Deterministic Sync Protocol):
 *   getFormationTargets3d(preset, globalN, start, end, seed)
 *   → generates all globalN points with a seeded PRNG, returns [start, end) slice.
 *   Every tab calling this with the same args gets the SAME points.
 *
 * Backward-compatible: getFormationTargets3d(preset, n) still works.
 *
 * @param {string} preset    — preset name
 * @param {number} globalN   — total drone count across ALL tabs
 * @param {number} [start=0] — first global index for this tab's slice
 * @param {number} [end]     — exclusive end index (defaults to globalN)
 * @param {number} [seed=0]  — PRNG seed (0 = use Math.random, non-deterministic)
 * @returns Array<{x, y, z}>
 */
export function getFormationTargets3d(preset, globalN, start = 0, end = null, seed = 0) {
  end = end ?? globalN;
  const prevRng = _rng3d;
  if (seed !== 0) _rng3d = mulberry32(seed);
  try {
    const fn = PRESETS_3D[preset] ?? sphereFormation;
    const all = fn(globalN);
    return (start === 0 && end === globalN) ? all : all.slice(start, end);
  } finally {
    _rng3d = prevRng;
  }
}
