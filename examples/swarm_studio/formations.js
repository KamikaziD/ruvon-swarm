/**
 * formations.js — Preset formation target positions for the Ruvon Swarm Studio.
 *
 * Each preset is defined as a function that returns an array of normalized
 * {x, y} coordinates in [0, 1] space. The renderer scales to canvas size.
 *
 * Patterns: HORSE, HEART, BIRDS, WATERFALL, CIRCLE, SPIRAL, DIAMOND, RUVON
 * Dynamic: textFormation(text, n) — canvas rasterisation of any string
 */

"use strict";

// ---------------------------------------------------------------------------
// Mulberry32 seeded PRNG — identical implementation in Python (ruvon_swarm/utils.py)
// Initialize with a seed to get a deterministic sequence across all tabs.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Module-level RNG — swapped to a seeded instance inside getFormationTargets()
// so formation functions need zero signature changes.
let _rng = Math.random;

// ---------------------------------------------------------------------------
// Utility: sample N points from a parametric curve
// ---------------------------------------------------------------------------
function sampleCurve(fn, n, tMin = 0, tMax = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = tMin + (i / (n - 1)) * (tMax - tMin);
    pts.push(fn(t));
  }
  return pts;
}

// Normalize a point cloud so it fills [margin, 1-margin]² centered
function normalize(pts, margin = 0.05) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scale = Math.min((1 - 2 * margin) / rangeX, (1 - 2 * margin) / rangeY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return pts.map(p => ({
    x: 0.5 + (p.x - cx) * scale,
    y: 0.5 + (p.y - cy) * scale,
  }));
}

// Add grid-jittered fill points to reach target count
function fillToCount(pts, n, jitter = 0.015) {
  if (pts.length === 0) return [];
  if (pts.length > n) {
    // Uniform subsample — stride through the full array so all rows are represented,
    // not just the top (pts are in row-major order from the canvas raster scan)
    const step = pts.length / n;
    return Array.from({ length: n }, (_, i) => pts[Math.floor(i * step)]);
  }
  // pts.length <= n: keep all originals and pad with jittered duplicates
  const result = [...pts];
  let i = 0;
  while (result.length < n) {
    const base = pts[i % pts.length];
    result.push({
      x: Math.max(0.02, Math.min(0.98, base.x + (_rng() - 0.5) * jitter * 2)),
      y: Math.max(0.02, Math.min(0.98, base.y + (_rng() - 0.5) * jitter * 2)),
    });
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// CIRCLE — baseline / default / unknown intent
// ---------------------------------------------------------------------------
function circleFormation(n) {
  const pts = [];
  // Concentric rings
  let remaining = n;
  let ring = 0;
  while (remaining > 0) {
    const r = 0.08 + ring * 0.08;
    const count = ring === 0 ? 1 : Math.min(remaining, Math.round(2 * Math.PI * r / 0.06));
    for (let i = 0; i < count && remaining > 0; i++) {
      const angle = (2 * Math.PI * i) / count;
      pts.push({ x: 0.5 + r * Math.cos(angle), y: 0.5 + r * Math.sin(angle) });
      remaining--;
    }
    ring++;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// HEART
// ---------------------------------------------------------------------------
function heartFormation(n) {
  // Parametric heart: x = 16sin³(t), y = 13cos(t) - 5cos(2t) - 2cos(3t) - cos(4t)
  const outline = Math.min(n, Math.ceil(n * 0.6));
  const fill    = n - outline;

  const outlinePts = sampleCurve(t => {
    const a = t * 2 * Math.PI;
    return {
      x:  16 * Math.pow(Math.sin(a), 3) / 17,
      y: -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17,
    };
  }, outline);

  // Fill: random points inside the heart (rejection sampling)
  const fillPts = [];
  let attempts = 0;
  while (fillPts.length < fill && attempts < fill * 20) {
    attempts++;
    const u = _rng() * 2 - 1, v = _rng() * 2 - 1;
    // Heart interior test: u² + (v - |u|^(2/3))² < 1  (approximate)
    const abs = Math.abs(u);
    if (u * u + Math.pow(v - Math.pow(abs, 2 / 3), 2) < 0.85) {
      fillPts.push({ x: u / 1.7, y: (-v + 0.3) / 1.7 });
    }
  }

  return normalize([...outlinePts, ...fillPts]);
}

// ---------------------------------------------------------------------------
// HORSE (running silhouette approximated from key waypoints)
// ---------------------------------------------------------------------------
function horseFormation(n) {
  // Rough running horse outline as hand-tuned control points (normalized 0..1)
  // Traced from a silhouette: head up-right, body, legs extended
  const controlPts = [
    // Head
    { x: 0.72, y: 0.08 }, { x: 0.78, y: 0.10 }, { x: 0.82, y: 0.14 },
    { x: 0.80, y: 0.18 }, { x: 0.76, y: 0.20 },
    // Neck
    { x: 0.70, y: 0.22 }, { x: 0.64, y: 0.26 },
    // Back (top line)
    { x: 0.56, y: 0.24 }, { x: 0.44, y: 0.25 }, { x: 0.32, y: 0.28 },
    { x: 0.22, y: 0.34 },
    // Rump + tail
    { x: 0.14, y: 0.30 }, { x: 0.08, y: 0.26 }, { x: 0.04, y: 0.28 },
    { x: 0.06, y: 0.32 },
    // Hind legs (extended back)
    { x: 0.12, y: 0.36 }, { x: 0.10, y: 0.50 }, { x: 0.08, y: 0.64 },
    { x: 0.10, y: 0.72 }, { x: 0.14, y: 0.74 },
    { x: 0.18, y: 0.70 }, { x: 0.20, y: 0.56 },
    { x: 0.24, y: 0.44 }, { x: 0.28, y: 0.38 },
    // Belly
    { x: 0.36, y: 0.40 }, { x: 0.48, y: 0.40 }, { x: 0.58, y: 0.40 },
    // Front legs (extended forward)
    { x: 0.62, y: 0.42 }, { x: 0.66, y: 0.54 }, { x: 0.68, y: 0.68 },
    { x: 0.72, y: 0.74 }, { x: 0.76, y: 0.72 },
    { x: 0.76, y: 0.58 }, { x: 0.74, y: 0.44 },
    { x: 0.78, y: 0.40 }, { x: 0.82, y: 0.44 }, { x: 0.84, y: 0.56 },
    { x: 0.86, y: 0.70 }, { x: 0.88, y: 0.74 },
    { x: 0.90, y: 0.72 }, { x: 0.88, y: 0.58 }, { x: 0.84, y: 0.44 },
    // Chest back to neck
    { x: 0.72, y: 0.34 }, { x: 0.68, y: 0.26 },
  ];

  return fillToCount(normalize(controlPts, 0.04), n, 0.025);
}

// ---------------------------------------------------------------------------
// BIRDS (V-formation flock)
// ---------------------------------------------------------------------------
function birdsFormation(n) {
  const pts = [];
  // Lead bird at center-top
  pts.push({ x: 0.5, y: 0.12 });

  // V-wings: each layer adds 2 birds per side
  let layer = 1;
  while (pts.length < n) {
    const spread = layer * 0.06;
    const drop   = layer * 0.05;
    // Left wing
    for (let k = 0; k < layer && pts.length < n; k++) {
      pts.push({ x: 0.5 - spread - k * 0.04, y: 0.12 + drop + k * 0.03 });
    }
    // Right wing
    for (let k = 0; k < layer && pts.length < n; k++) {
      pts.push({ x: 0.5 + spread + k * 0.04, y: 0.12 + drop + k * 0.03 });
    }
    layer++;
  }
  return normalize(pts.slice(0, n), 0.06);
}

// ---------------------------------------------------------------------------
// WATERFALL (cascading streams)
// ---------------------------------------------------------------------------
function waterfallFormation(n) {
  const streams = 7;
  const pts = [];
  for (let s = 0; s < streams; s++) {
    const xBase = 0.1 + (s / (streams - 1)) * 0.8;
    const count  = Math.round(n / streams);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      // Slight sine sway per stream, staggered phase
      const xSway = 0.015 * Math.sin(t * Math.PI * 6 + (s * 0.8));
      pts.push({ x: xBase + xSway, y: 0.05 + t * 0.88 });
    }
  }
  return fillToCount(pts, n, 0.01);
}

// ---------------------------------------------------------------------------
// SPIRAL
// ---------------------------------------------------------------------------
function spiralFormation(n) {
  const turns = 3.5;
  return normalize(sampleCurve(t => {
    const angle = t * turns * 2 * Math.PI;
    const r = 0.05 + t * 0.42;
    return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
  }, n), 0.04);
}

// ---------------------------------------------------------------------------
// DIAMOND
// ---------------------------------------------------------------------------
function diamondFormation(n) {
  const pts = [];
  const layers = Math.ceil(Math.sqrt(n / 2));
  for (let l = 0; l <= layers && pts.length < n; l++) {
    const w = l;
    for (let i = -w; i <= w && pts.length < n; i++) {
      if (Math.abs(i) + Math.abs(l - layers / 2) <= layers) {
        pts.push({ x: i / layers * 0.5, y: (l / layers - 0.5) * 0.9 });
      }
    }
  }
  return normalize(fillToCount(pts, n, 0.02), 0.04);
}

// ---------------------------------------------------------------------------
// RUVON logo-ish (R shape)
// ---------------------------------------------------------------------------
function ruvonFormation(n) {
  const pts = [];
  // Vertical stroke
  for (let i = 0; i < 20; i++) pts.push({ x: 0.2, y: 0.1 + i * 0.04 });
  // Top arch of R
  for (let t = 0; t <= 1; t += 0.05) {
    const angle = -Math.PI / 2 + t * Math.PI;
    pts.push({ x: 0.2 + 0.18 + 0.18 * Math.cos(angle), y: 0.1 + 0.12 + 0.12 * Math.sin(angle) });
  }
  // Horizontal mid-bar
  for (let i = 0; i < 8; i++) pts.push({ x: 0.2 + i * 0.022, y: 0.34 });
  // Diagonal leg
  for (let i = 0; i < 14; i++) pts.push({ x: 0.38 + i * 0.03, y: 0.34 + i * 0.045 });

  return fillToCount(normalize(pts, 0.06), n, 0.03);
}

// ---------------------------------------------------------------------------
// STAR — 5-pointed
// ---------------------------------------------------------------------------
function starFormation(n) {
  const R = 0.45, r = 0.18, spikes = 5;
  const verts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = -Math.PI / 2 + (i / (spikes * 2)) * 2 * Math.PI;
    verts.push({ x: 0.5 + (i % 2 === 0 ? R : r) * Math.cos(a),
                 y: 0.5 + (i % 2 === 0 ? R : r) * Math.sin(a) });
  }
  verts.push(verts[0]);
  return fillToCount(normalize(_polyline(verts, 0.018), 0.04), n, 0.02);
}

// ---------------------------------------------------------------------------
// TRIANGLE — equilateral
// ---------------------------------------------------------------------------
function triangleFormation(n) {
  const h = Math.sqrt(3) / 2;
  const verts = [
    { x: 0.5, y: 0 }, { x: 0, y: h }, { x: 1, y: h }, { x: 0.5, y: 0 },
  ];
  return fillToCount(normalize(_polyline(verts, 0.015), 0.04), n, 0.02);
}

// ---------------------------------------------------------------------------
// CROSS — plus sign
// ---------------------------------------------------------------------------
function crossFormation(n) {
  const w = 0.15;
  const verts = [
    { x: 0.5 - w, y: 0 },     { x: 0.5 + w, y: 0 },
    { x: 0.5 + w, y: 0.5 - w }, { x: 1,       y: 0.5 - w },
    { x: 1,       y: 0.5 + w }, { x: 0.5 + w, y: 0.5 + w },
    { x: 0.5 + w, y: 1 },     { x: 0.5 - w, y: 1 },
    { x: 0.5 - w, y: 0.5 + w }, { x: 0,       y: 0.5 + w },
    { x: 0,       y: 0.5 - w }, { x: 0.5 - w, y: 0.5 - w },
    { x: 0.5 - w, y: 0 },
  ];
  return fillToCount(normalize(_polyline(verts, 0.015), 0.04), n, 0.015);
}

// ---------------------------------------------------------------------------
// ARROW — right-pointing
// ---------------------------------------------------------------------------
function arrowFormation(n) {
  const verts = [
    { x: 0,    y: 0.3 }, { x: 0.55, y: 0.3  },
    { x: 0.55, y: 0.05}, { x: 1,    y: 0.5  },
    { x: 0.55, y: 0.95}, { x: 0.55, y: 0.7  },
    { x: 0,    y: 0.7 }, { x: 0,    y: 0.3  },
  ];
  return fillToCount(normalize(_polyline(verts, 0.015), 0.04), n, 0.015);
}

// ---------------------------------------------------------------------------
// HEXAGON
// ---------------------------------------------------------------------------
function hexagonFormation(n) {
  const verts = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * 2 * Math.PI - Math.PI / 6;
    verts.push({ x: 0.5 + 0.46 * Math.cos(a), y: 0.5 + 0.46 * Math.sin(a) });
  }
  return fillToCount(normalize(_polyline(verts, 0.015), 0.04), n, 0.02);
}

// ---------------------------------------------------------------------------
// SMILEY face
// ---------------------------------------------------------------------------
function smileyFormation(n) {
  const pts = [];
  // Face outline
  for (let t = 0; t < Math.PI * 2; t += 0.025)
    pts.push({ x: 0.5 + 0.46 * Math.cos(t), y: 0.5 + 0.46 * Math.sin(t) });
  // Left eye
  for (let t = 0; t < Math.PI * 2; t += 0.08)
    pts.push({ x: 0.34 + 0.07 * Math.cos(t), y: 0.38 + 0.07 * Math.sin(t) });
  // Right eye
  for (let t = 0; t < Math.PI * 2; t += 0.08)
    pts.push({ x: 0.66 + 0.07 * Math.cos(t), y: 0.38 + 0.07 * Math.sin(t) });
  // Smile (lower arc)
  for (let t = 0.15; t < Math.PI - 0.15; t += 0.035)
    pts.push({ x: 0.5 + 0.28 * Math.cos(Math.PI + t), y: 0.62 - 0.16 * Math.sin(Math.PI + t) });
  return fillToCount(pts, n, 0.015);
}

// ---------------------------------------------------------------------------
// LIGHTNING bolt
// ---------------------------------------------------------------------------
function lightningFormation(n) {
  const verts = [
    { x: 0.62, y: 0    }, { x: 0.30, y: 0.48 },
    { x: 0.52, y: 0.48 }, { x: 0.20, y: 1    },
    { x: 0.56, y: 0.52 }, { x: 0.36, y: 0.52 },
    { x: 0.62, y: 0    },
  ];
  return fillToCount(normalize(_polyline(verts, 0.015), 0.04), n, 0.02);
}

// ---------------------------------------------------------------------------
// ROCKET
// ---------------------------------------------------------------------------
function rocketFormation(n) {
  const pts = [];
  // Nose cone
  for (let t = 0; t <= 1; t += 0.03) {
    const hw = 0.14 * (1 - t);
    pts.push({ x: 0.5 - hw, y: 0.05 + t * 0.22 });
    pts.push({ x: 0.5 + hw, y: 0.05 + t * 0.22 });
  }
  // Body
  for (let t = 0; t <= 1; t += 0.02) {
    pts.push({ x: 0.36, y: 0.27 + t * 0.45 });
    pts.push({ x: 0.64, y: 0.27 + t * 0.45 });
  }
  // Left fin
  _polyline([{x:0.36,y:0.60},{x:0.16,y:0.88},{x:0.36,y:0.72}], 0.02)
    .forEach(p => pts.push(p));
  // Right fin
  _polyline([{x:0.64,y:0.60},{x:0.84,y:0.88},{x:0.64,y:0.72}], 0.02)
    .forEach(p => pts.push(p));
  // Nozzle + exhaust
  for (let t = 0; t <= 1; t += 0.04) {
    pts.push({ x: 0.5 + (_rng() - 0.5) * 0.16 * (1 + t), y: 0.72 + t * 0.22 });
  }
  return fillToCount(normalize(pts, 0.04), n, 0.02);
}

// ---------------------------------------------------------------------------
// Shared polyline sampler — densely interpolates a list of vertices
// ---------------------------------------------------------------------------
function _polyline(verts, density = 0.015) {
  const pts = [];
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.ceil(d / density));
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  pts.push(verts[verts.length - 1]);
  return pts;
}

// ---------------------------------------------------------------------------
// Lookup table + fuzzy matcher
// ---------------------------------------------------------------------------
export const PRESETS = {
  circle:    circleFormation,
  heart:     heartFormation,
  horse:     horseFormation,
  birds:     birdsFormation,
  waterfall: waterfallFormation,
  spiral:    spiralFormation,
  diamond:   diamondFormation,
  ruvon:     ruvonFormation,
  star:      starFormation,
  triangle:  triangleFormation,
  cross:     crossFormation,
  arrow:     arrowFormation,
  hexagon:   hexagonFormation,
  smiley:    smileyFormation,
  lightning: lightningFormation,
  rocket:    rocketFormation,
};

// Aliases and common variants
const ALIASES = {
  "running horse": "horse", "galloping horse": "horse", "horse running": "horse",
  "flock": "birds", "flocking birds": "birds", "bird flock": "birds", "v formation": "birds",
  "pulsing heart": "heart", "love": "heart",
  "cascading waterfall": "waterfall", "cascade": "waterfall", "falling water": "waterfall",
  "helix": "spiral", "swirl": "spiral", "galaxy": "spiral", "vortex": "spiral",
  "rhombus": "diamond", "gem": "diamond",
  "logo": "ruvon",
  "five pointed star": "star", "5 point star": "star", "shooting star": "star",
  "plus": "cross", "plus sign": "cross", "swiss cross": "cross",
  "right arrow": "arrow", "pointer": "arrow",
  "pentagon": "hexagon", "hex": "hexagon",
  "happy face": "smiley", "smile": "smiley", "emoji": "smiley",
  "bolt": "lightning", "thunder": "lightning", "lightning bolt": "lightning",
  "spaceship": "rocket", "space rocket": "rocket",
};

/** Levenshtein distance for fuzzy matching */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
               : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// TEXT — rasterise any string into drone positions via a hidden Canvas
// ---------------------------------------------------------------------------

/**
 * Render `text` into a hidden canvas and sample dark pixels as target positions.
 * Must be called from the main thread where `document` is available.
 *
 * @param {string} text   — any string (letters, digits, emoji)
 * @param {number} n      — number of drones
 * @returns Array<{x, y}> normalized [0, 1] coordinates
 */
// Detect if a string is emoji-only (no ASCII printable characters).
// A lone period "." or "?" is NOT emoji — only Unicode codepoints above U+00FF qualify.
function isEmojiOnly(text) {
  const stripped = text.replace(/[\u200D\uFE0E\uFE0F]/g, "").trim();
  if (!stripped) return false;
  // Reject anything that contains ASCII printable chars (0x20–0x7E)
  if (/[\x20-\x7E]/.test(stripped)) return false;
  // Must contain at least one actual emoji / high codepoint
  return /[\u{100}-\u{10FFFF}]/u.test(stripped);
}

/**
 * Rescale sampled points so they fill [margin, 1-margin] × [margin, 1-margin].
 * Each axis is normalised independently — this guarantees the formation always
 * uses the full canvas regardless of the original glyph aspect ratio or font metrics.
 */
function rescalePts(pts, margin = 0.04) {
  if (pts.length === 0) return pts;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;
  const available = 1 - 2 * margin;
  // Independent scale per axis — both always fill [margin, 1-margin]
  const scaleX = available / spanX;
  const scaleY = available / spanY;
  const offX = margin;
  const offY = margin;
  return pts.map(p => ({
    x: offX + (p.x - minX) * scaleX,
    y: offY + (p.y - minY) * scaleY,
  }));
}

export function textFormation(text, n) {
  const emoji = isEmojiOnly(text);

  // Use a large canvas so font rasterisation has full resolution.
  // Aspect ratio: emoji → square; text → wide letterbox.
  const W = emoji ? 512 : 1200;
  const H = emoji ? 512 : 320;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Transparent background — sample alpha channel so both text and emoji work
  ctx.clearRect(0, 0, W, H);

  // Emoji need a colour-emoji font stack; text uses monospace for crisp strokes
  const fontFamily = emoji
    ? `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
    : `monospace`;

  // Start large and shrink until the glyph fits the canvas width
  let fontSize = emoji ? Math.min(W, H) * 0.85 : 220;
  const makeFontStr = () => emoji
    ? `${fontSize}px ${fontFamily}`
    : `bold ${fontSize}px ${fontFamily}`;
  ctx.font = makeFontStr();
  while (ctx.measureText(text).width > W * 0.92 && fontSize > 18) {
    fontSize -= 4;
    ctx.font = makeFontStr();
  }

  // Render centred
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H / 2);

  // Sample occupied pixels via alpha — works for dark text AND colour emoji
  const data = ctx.getImageData(0, 0, W, H).data;
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / (n * 6))));
  const raw = [];
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step)
      if ((data[(y * W + x) * 4 + 3] ?? 0) > 40)  // alpha > ~16%
        raw.push({ x: x / W, y: y / H });

  // Fallback to circle if nothing rendered (e.g. unsupported emoji on this OS)
  if (raw.length === 0) return circleFormation(n);

  // Normalise bounding box → fill canvas evenly regardless of font metric padding
  const pts = rescalePts(raw, emoji ? 0.05 : 0.03);

  // Tight jitter so letter/shape strokes stay legible
  return fillToCount(pts, n, 0.002);
}

// ---------------------------------------------------------------------------
// Fuzzy intent resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a free-text intent string to a preset name.
 * Returns the preset name (always valid — falls back to "circle").
 */
export function resolveIntent(text) {
  const t = text.trim().toLowerCase();
  if (!t) return "circle";

  // Exact match
  if (PRESETS[t]) return t;

  // Alias match
  if (ALIASES[t]) return ALIASES[t];

  // Fuzzy: find closest preset/alias key
  const candidates = [...Object.keys(PRESETS), ...Object.keys(ALIASES)];
  let best = "circle", bestDist = Infinity;
  for (const cand of candidates) {
    const dist = levenshtein(t, cand);
    if (dist < bestDist && dist <= Math.max(3, Math.floor(cand.length / 3))) {
      bestDist = dist;
      best = ALIASES[cand] ?? cand;
    }
  }
  return best;
}

/**
 * Get formation target positions for a named preset.
 *
 * When called with start/end/seed (Deterministic Sync Protocol):
 *   getFormationTargets(preset, globalN, start, end, seed)
 *   → generates all globalN points with a seeded PRNG, returns [start, end) slice.
 *   Every tab calling this with the same args gets the SAME points.
 *
 * Backward-compatible: getFormationTargets(preset, n) still works.
 *
 * @param {string} preset    — preset name
 * @param {number} globalN   — total drone count across ALL tabs
 * @param {number} [start=0] — first global index for this tab's slice
 * @param {number} [end]     — exclusive end index (defaults to globalN)
 * @param {number} [seed=0]  — PRNG seed (0 = use Math.random, non-deterministic)
 * @returns Array<{x, y}>
 */
export function getFormationTargets(preset, globalN, start = 0, end = null, seed = 0) {
  end = end ?? globalN;
  const prevRng = _rng;
  if (seed !== 0) _rng = mulberry32(seed);
  try {
    const fn = PRESETS[preset] ?? circleFormation;
    const all = fn(globalN);
    return (start === 0 && end === globalN) ? all : all.slice(start, end);
  } finally {
    _rng = prevRng;
  }
}
