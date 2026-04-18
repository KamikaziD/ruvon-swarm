/**
 * command_brain.js — Tier 1 semantic resolver (Web Worker)
 *
 * Runs MiniLM-L6-v2 (23 MB) in this worker for instant preset matching.
 * When confidence is low OR trigger words detected, posts ESCALATE to the
 * main thread. The main thread runs wllama (Tier 2 LLM) directly — wllama
 * requires document + proper nested-worker support unavailable in a Worker.
 *
 * Messages out:
 *   LOADING / PROGRESS / READY           — MiniLM download lifecycle
 *   COMMAND { action, preset, confidence, reqId }  — fast path (MiniLM only)
 *   ESCALATE { text, reqId, miniLmFallback }       — needs LLM (main thread)
 *   MODEL_SWITCH_REQUEST { model }        — forward model change to main thread
 *   ERROR { message }
 *
 * Messages in:
 *   INIT
 *   SET_MODEL { model }
 *   RESOLVE { text, reqId }
 */

"use strict";

// ---------------------------------------------------------------------------
// Transformers.js CDNs (try in order — v2 is more compatible with workers)
// ---------------------------------------------------------------------------
const TRANSFORMERS_CDNS = [
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js",
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js",
];

// ---------------------------------------------------------------------------
// MiniLM preset descriptions — full sentences give better cosine similarity
// ---------------------------------------------------------------------------

// 3D presets — action:"formation3d"
const PRESET_DESCRIPTIONS_3D = {
  sphere:  "Form a three-dimensional sphere or globe or ball shape floating in space.",
  helix:   "Arrange drones in a double helix or DNA spiral or twisted corkscrew shape in 3D.",
  dna:     "Form a DNA double helix or genetic code spiral or twisted ladder in three dimensions.",
  torus:   "Create a torus or donut or ring shape floating in three-dimensional space.",
  wave:    "Make the drones ripple in a wave pattern or sine wave or ocean wave in 3D.",
  vortex:  "Spin drones into a vortex or tornado or whirlpool funnel shape in 3D space.",
  cube:    "Form a three-dimensional cube or box or rectangular prism shape with drone vertices.",
  ruvon3d: "Form the Ruvon logo or letter R shape rotating in three dimensions, spinning logo.",
};

// 2D presets — action:"formation"
const PRESET_DESCRIPTIONS_2D = {
  circle:    "Form a circular ring shape with drones arranged in concentric orbit loops.",
  heart:     "Arrange drones into a heart shape, like a love symbol or Valentine's day heart.",
  horse:     "Make the drones form a running horse or galloping animal silhouette.",
  birds:     "Fly the drones in a V-formation like a migrating bird flock or geese in the sky.",
  waterfall: "Let the drones cascade downward in streams like a waterfall or falling water.",
  spiral:    "Form a flat spiral or galaxy shape, like a swirling vortex or spinning galaxy.",
  diamond:   "Arrange drones into a diamond or rhombus shape, like a gem or crystal lattice.",
  ruvon:     "Form the letter R or the Ruvon logo shape with the drones in a flat 2D formation.",
  star:      "Form a five-pointed star shape, like a shooting star or gold star symbol.",
  triangle:  "Arrange drones into a triangle or pyramid shape, like a delta or wedge.",
  cross:     "Form a cross or plus sign shape, like a medical cross or addition symbol.",
  arrow:     "Make the drones form a right-pointing arrow or directional pointer shape.",
  hexagon:   "Arrange drones into a hexagon or six-sided polygon shape, like a honeycomb cell.",
  smiley:    "Form a smiley face or happy face emoji shape with eyes and a smile.",
  lightning: "Form a lightning bolt or thunderbolt zigzag shape, like an electric flash.",
  rocket:    "Make the drones form a rocket ship or spaceship silhouette ready for launch.",
};

// Combined for backward compat — store which is 3D
const PRESET_DESCRIPTIONS = { ...PRESET_DESCRIPTIONS_3D, ...PRESET_DESCRIPTIONS_2D };
const PRESET_IS_3D = new Set(Object.keys(PRESET_DESCRIPTIONS_3D));

// Trigger words that always escalate to LLM regardless of MiniLM confidence.
// "draw", "make a", "show a", "create a" trigger open-ended object requests.
// "form a" is intentionally excluded — it's a common preset-formation prefix (e.g. "form a circle").
// Novel shape words: pretzel, butterfly, trefoil, galaxy, fractal, custom, shape → escalate for parametric generation.
const ESCALATION_RE = /\bwrite\b|\bdisplay\b|\bshow\s+\w*\s*word|\bspell\b|\bdraw\b|\bprint\b|\bthe\s+word\b|\btext\b|\bletter\b|\bword\b|\btype\b|\bsay\b|\bmake\s+a\b|\bshow\s+a\b|\bcreate\s+a\b|\bbuild\s+a\b|\bpretzel\b|\bbutterfly\b|\btrefoil\b|\bfractal\b|\bknot\b|\bfigure.?8\b|\brose\b|\bgalaxy\b|\bshell\b|\bcustom\s+shape\b|\binvent\b|\bnovel\b/i;

let _miniLm = null;
let _presetEmbeddings = null;
let _miniLmReady = false;

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// ---------------------------------------------------------------------------
// MiniLM loading
// ---------------------------------------------------------------------------
async function loadMiniLm() {
  self.postMessage({ type: "LOADING" });

  let pipeline, env, lastErr = null;
  for (const url of TRANSFORMERS_CDNS) {
    try {
      const mod = await import(url);
      pipeline = mod.pipeline; env = mod.env;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!pipeline) throw new Error("Could not load transformers.js: " + (lastErr?.message ?? "unknown"));

  try { env.allowLocalModels = false; } catch (_) {}
  try { env.allowRemoteModels = true; } catch (_) {}

  _miniLm = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    {
      progress_callback: ({ status, progress }) => {
        if (status === "progress" && typeof progress === "number")
          self.postMessage({ type: "PROGRESS", pct: Math.round(progress) });
      },
    }
  );

  _presetEmbeddings = new Map();
  for (const [preset, desc] of Object.entries(PRESET_DESCRIPTIONS)) {
    const out = await _miniLm(desc, { pooling: "mean", normalize: true });
    _presetEmbeddings.set(preset, out.data instanceof Float32Array ? out.data.slice() : new Float32Array(out.data));
  }

  _miniLmReady = true;
  self.postMessage({ type: "READY" });
}

// ---------------------------------------------------------------------------
// MiniLM inference
// ---------------------------------------------------------------------------
async function runMiniLm(text) {
  if (!_miniLmReady || !_miniLm) return { preset: "circle", confidence: 0 };
  const out = await _miniLm(text, { pooling: "mean", normalize: true });
  const qVec = out.data instanceof Float32Array ? out.data.slice() : new Float32Array(out.data);
  let best = "circle", bestSim = -1;
  for (const [preset, vec] of _presetEmbeddings) {
    const sim = cosineSim(qVec, vec);
    if (sim > bestSim) { bestSim = sim; best = preset; }
  }
  return { preset: best, confidence: parseFloat(bestSim.toFixed(3)) };
}

// ---------------------------------------------------------------------------
// Resolve entry point
// ---------------------------------------------------------------------------
async function resolve(text, reqId) {
  const trimmed = text.trim();
  if (!trimmed) return;

  const { preset: miniLmPreset, confidence } = await runMiniLm(trimmed);
  const needsEscalation = confidence < 0.4 || ESCALATION_RE.test(trimmed);

  if (!needsEscalation) {
    // Fast path — MiniLM confident, no LLM needed
    const action = PRESET_IS_3D.has(miniLmPreset) ? "formation3d" : "formation";
    self.postMessage({ type: "COMMAND", action, preset: miniLmPreset, confidence, reqId });
    return;
  }

  // Signal main thread to run wllama (LLM lives on main thread, not in worker)
  self.postMessage({
    type: "ESCALATE",
    text: trimmed,
    reqId,
    miniLmFallback: { preset: miniLmPreset, confidence },
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
self.onmessage = async (evt) => {
  const msg = evt.data;
  if (!msg?.type) return;
  try {
    switch (msg.type) {
      case "INIT":
        await loadMiniLm();
        break;
      case "SET_MODEL":
        // wllama lives on the main thread — forward the model switch request
        self.postMessage({ type: "MODEL_SWITCH_REQUEST", model: msg.model });
        break;
      case "RESOLVE":
        await resolve(msg.text, msg.reqId);
        break;
    }
  } catch (err) {
    console.error("[command_brain]", err);
    self.postMessage({ type: "ERROR", message: err.message });
  }
};
