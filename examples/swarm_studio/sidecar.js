"use strict";
/**
 * sidecar.js — Hardware Governance Worker for browser_demo_5.
 *
 * Acts as the Air Traffic Controller for local resources:
 *   • Tracks rolling frame timing (30-frame window)
 *   • Throttles LLM inference when physics is under pressure
 *   • Calculates the Green Tech energy offset (local vs cloud)
 *   • Receives WebGPU timestamp query results and formats stats
 *
 * Message Protocol
 * ────────────────
 * IN  {type:"FRAME_PING",    t:DOMHighResTimeStamp}
 * IN  {type:"GPU_TIMESTAMP", ns:number}          (optional WebGPU query result)
 * IN  {type:"LLM_TOKEN_RATE",tps:number}
 * IN  {type:"OPS_TICK",      ops:number}         (physics steps per second)
 *
 * OUT {type:"FRAME_STATS",   avgMs:number, p95Ms:number}
 * OUT {type:"THROTTLE_LLM"}                      (avg frame > 18ms)
 * OUT {type:"RESUME_LLM"}                        (avg frame < 14ms after throttle)
 * OUT {type:"GREEN_STATS",   localW:number, cloudW:number, pctSaved:number}
 */

/* global self */

// ── Config ────────────────────────────────────────────────────────────────────

const WINDOW        = 30;       // rolling frame window
const THROTTLE_MS   = 18;       // avg frame > this → throttle LLM
const RESUME_MS     = 14;       // avg frame < this → resume LLM (hysteresis)
const LOCAL_W_PER_OP  = 0.00000012;  // Watts per physics op (edge device estimate)
const CLOUD_W_PER_OP  = 0.0000012;   // Watts per equivalent cloud op (10× factor)
const GREEN_INTERVAL  = 5000;        // ms between green stat broadcasts

// ── State ─────────────────────────────────────────────────────────────────────

const frameTimes = [];         // ring buffer of frame durations (ms)
let lastT        = null;
let throttled    = false;
let totalOps     = 0;          // cumulative physics operations
let lastGreenMs  = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pushFrameTime(t) {
  if (lastT !== null) {
    const dt = t - lastT;
    if (dt > 0 && dt < 1000) {   // ignore outliers (tab hidden etc.)
      frameTimes.push(dt);
      if (frameTimes.length > WINDOW) frameTimes.shift();
    }
  }
  lastT = t;
}

function avg(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function p95(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

function broadcastFrameStats() {
  if (frameTimes.length < 5) return;
  const avgMs = avg(frameTimes);
  const p95Ms = p95(frameTimes);

  self.postMessage({ type: "FRAME_STATS", avgMs: +avgMs.toFixed(2), p95Ms: +p95Ms.toFixed(2) });

  if (!throttled && avgMs > THROTTLE_MS) {
    throttled = true;
    self.postMessage({ type: "THROTTLE_LLM" });
  } else if (throttled && avgMs < RESUME_MS) {
    throttled = false;
    self.postMessage({ type: "RESUME_LLM" });
  }
}

function broadcastGreenStats(now) {
  if (now - lastGreenMs < GREEN_INTERVAL) return;
  lastGreenMs = now;

  const localW  = totalOps * LOCAL_W_PER_OP;
  const cloudW  = totalOps * CLOUD_W_PER_OP;
  const pctSaved = cloudW > 0 ? Math.round((1 - localW / cloudW) * 100) : 0;

  self.postMessage({
    type: "GREEN_STATS",
    localW:   +localW.toExponential(2),
    cloudW:   +cloudW.toExponential(2),
    pctSaved,
  });
}

// ── Message Handler ───────────────────────────────────────────────────────────

self.onmessage = (e) => {
  const { type } = e.data;

  if (type === "FRAME_PING") {
    const { t } = e.data;
    pushFrameTime(t);
    broadcastFrameStats();
    broadcastGreenStats(t);
  }

  else if (type === "OPS_TICK") {
    totalOps += e.data.ops ?? 0;
  }

  else if (type === "GPU_TIMESTAMP") {
    // GPU timestamp in nanoseconds → convert to ms for display
    const gpuMs = (e.data.ns / 1e6).toFixed(3);
    self.postMessage({ type: "GPU_MS", gpuMs: +gpuMs });
  }

  else if (type === "LLM_TOKEN_RATE") {
    // Future: use token rate to weight throttle decisions
    // For now just forward it for display
    self.postMessage({ type: "LLM_STATS", tps: e.data.tps });
  }
};
