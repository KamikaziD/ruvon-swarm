"use strict";
/**
 * pyodide_worker.js — ruvon-edge Pyodide worker for browser_demo_5.
 *
 * Adapted from src/ruvon_edge/browser_loader.js.
 * Differences:
 *   • Uses ruvon_edge (not rufus_edge) imports
 *   • Reports granular loading progress to main thread
 *   • Supports per-step workflow callbacks (STEP_COMPLETED)
 *   • Supports Glass Box SQLite log queries (QUERY_LOG / LOG_RESULT)
 *   • Embeds drone_command_steps.py source and writes it to Pyodide FS
 *
 * Message Protocol
 * ────────────────
 * IN  {type:"INIT"}
 * IN  {type:"EXECUTE",   command:string, reqId:number}
 * IN  {type:"QUERY_LOG", droneId:number, limit:number, reqId:number}
 * IN  {type:"STOP"}
 *
 * OUT {type:"LOADING",          stage:string, pct:number}
 * OUT {type:"READY",            agentId:string}
 * OUT {type:"WORKFLOW_STARTED", workflowId:string, reqId:number}
 * OUT {type:"STEP_COMPLETED",   step:string, stepNum:number, totalSteps:number, workflowId:string}
 * OUT {type:"RESULT",           result:object, workflowId:string, reqId:number}
 * OUT {type:"LOG_RESULT",       droneId:number, entries:Array, reqId:number}
 * OUT {type:"ERROR",            message:string}
 * OUT {type:"LOG",              level:string, text:string}
 */

/* global self, loadPyodide, importScripts */

// When served via serve.py locally, use the CDN proxy so CORP headers are guaranteed.
// When served from GitHub Pages (or any origin without the proxy), use the CDN directly —
// jsdelivr.net serves Pyodide files with Cross-Origin-Resource-Policy: cross-origin.
const _hasProxy = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const PYODIDE_VERSION   = "v0.26.4";
const PYODIDE_INDEX_URL = _hasProxy
  ? "/pyodide/"
  : `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const PYODIDE_CDN = PYODIDE_INDEX_URL + "pyodide.js";
// Wheels are served from the same origin (same-origin CORP is implicit).
const RUVON_SDK_WHEEL   = "./ruvon_sdk-0.1.2-py3-none-any.whl";
const RUVON_WHEEL       = "./ruvon_edge-0.1.2-py3-none-any.whl";
const RUVON_SWARM_WHEEL = "./ruvon_swarm-0.1.0-py3-none-any.whl";

// Step names for progress reporting — matches SwarmFormation workflow YAML
const STEP_NAMES = ["ParseCommand", "ValidateFormation", "BuildIntent", "LogFormation", "ExecuteFormation"];

// ── DroneCommand workflow YAML (now from ruvon-swarm package) ─────────────────
// Kept for reference; the real YAML is loaded from ruvon_swarm.workflows package.
const DRONE_COMMAND_YAML = `\
workflow_type: DroneCommand
description: "Execute a single drone swarm command via ruvon-edge"
version: "1"
initial_state_model_path: ruvon_swarm.state_models.SwarmFormationState
steps:
  - name: ParseCommand
    type: STANDARD
    function: ruvon_swarm.steps.formation.parse_command
    automate_next: true
  - name: ValidateFormation
    type: STANDARD
    function: ruvon_swarm.steps.formation.validate_formation
    automate_next: true
  - name: BuildIntent
    type: STANDARD
    function: ruvon_swarm.steps.formation.build_intent
    automate_next: true
  - name: LogFormation
    type: FIRE_AND_FORGET
    function: ruvon_swarm.steps.formation.log_formation
    automate_next: true
  - name: ExecuteFormation
    type: STANDARD
    function: ruvon_swarm.steps.formation.execute_formation
    automate_next: true
`;

// STEPS_PY removed — step functions now come from ruvon_swarm package (installed below).

// ── State ─────────────────────────────────────────────────────────────────────
let pyodide = null;
let agentReady = false;
let _commandLog = []; // in-memory glass-box log (max 200 entries)

function log(level, text) {
  self.postMessage({ type: "LOG", level, text });
}

function progress(stage, pct) {
  self.postMessage({ type: "LOADING", stage, pct });
}

// ── Step 1: wa-sqlite (in-memory mock) ───────────────────────────────────────
// Real wa-sqlite CDN imports are blocked by Cross-Origin-Embedder-Policy:require-corp
// (required for SharedArrayBuffer). We use an in-memory mock instead — adequate
// for the demo. Glass Box logs are kept in the JS-side _commandLog array.
async function initWaSqlite() {
  progress("wa-sqlite", 15);
  log("info", "WaSqlite: using in-memory mock (COEP-safe)");

  const _dbs = {};
  globalThis.WaSqlite = {
    async open(dbName) {
      if (!_dbs[dbName]) _dbs[dbName] = { tables: {}, rows: [] };
      const store = _dbs[dbName];
      return {
        // Returns [rows_array, columns_array] — Python destructures as (rows, columns)
        async execute(sql, _params = []) {
          // For SELECT: return empty rows with empty column list (nothing persisted)
          // For DDL/DML: return empty rows — Python ignores the result
          return [[], []];
        },
        async commit() {},
      };
    },
  };
}

// ── Step 2: Pyodide ───────────────────────────────────────────────────────────
async function initPyodide() {
  progress("pyodide", 20);
  log("info", "Loading Pyodide…");
  importScripts(PYODIDE_CDN);
  pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX_URL,
    stdout: (t) => log("stdout", t),
    stderr: (t) => log("stderr", t),
  });
  log("info", `Pyodide ${pyodide.version} loaded`);
  progress("pyodide", 45);
}

// ── Step 3: Install ruvon-edge ────────────────────────────────────────────────
async function installRuvonEdge() {
  progress("micropip", 50);
  log("info", "Installing ruvon-edge…");

  // Load pydantic via Pyodide's own pre-built WASM packages FIRST.
  // This installs the real pydantic + pydantic-core (compiled for WASM)
  // so micropip's resolver treats them as already satisfied.
  log("info", "Loading pydantic (Pyodide WASM build)…");
  await pyodide.loadPackage(["pydantic"]);
  log("info", "pydantic loaded");

  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");

  // Register mock packages with micropip's resolver BEFORE install.
  // micropip resolves deps by fetching PyPI metadata — it will fail for C
  // extensions (cryptography, cffi …) before any Python code runs.
  // add_mock_package() tells the resolver "already satisfied; skip".
  await pyodide.runPythonAsync(`
import micropip, sys
from unittest.mock import MagicMock

_MOCK_PKGS = {
    "cryptography":   "43.0.0",
    "pydantic-core":  "2.27.0",   # loaded via pyodide.loadPackage; skip PyPI lookup
    "cffi":           "1.17.0",
    "PyNaCl":         "1.5.0",
    "uvloop":         "0.21.0",
    "asyncpg":        "0.29.0",
    "orjson":         "3.10.0",
    "psutil":         "5.9.8",
    "alembic":        "1.13.0",
    "celery":         "5.4.0",
    "redis":          "5.0.0",
    "fastapi":        "0.111.0",
    "uvicorn":        "0.30.0",
    "wasmtime":       "20.0.0",
    "nats-py":        "2.9.0",
    "betterproto":    "0.9.0",
}
for _name, _ver in _MOCK_PKGS.items():
    micropip.add_mock_package(_name, _ver)

# Stub sub-modules so runtime imports don't raise ImportError
_RUNTIME_STUBS = [
    "cryptography", "cryptography.hazmat",
    "cryptography.hazmat.primitives",
    "cryptography.hazmat.primitives.asymmetric",
    "cryptography.hazmat.primitives.asymmetric.ed25519",
    "cryptography.hazmat.primitives.serialization",
    "cryptography.exceptions",
    "cffi", "_cffi_backend",
    "asyncpg", "orjson", "psutil",
    "nacl", "nacl.signing", "nacl.encoding",
    "alembic",
    "sqlalchemy.orm",
    "sqlalchemy.ext", "sqlalchemy.ext.asyncio",
    "celery", "kombu", "billiard", "amqp",
    "redis", "aioredis", "fastapi", "starlette", "uvicorn",
    "nats", "betterproto", "wasmtime",
]
for _m in _RUNTIME_STUBS:
    sys.modules.setdefault(_m, MagicMock())

# uvloop.EventLoopPolicy() must pass asyncio's isinstance check —
# MagicMock fails it. Use DefaultEventLoopPolicy so the guard in
# ruvon/__init__.py (which already has try/except ImportError) works.
import asyncio as _asyncio
_uvloop_mod = MagicMock()
_uvloop_mod.EventLoopPolicy = _asyncio.DefaultEventLoopPolicy
sys.modules["uvloop"] = _uvloop_mod
`);

  // Install ruvon-sdk first (ruvon-edge depends on it; both are private/local).
  log("info", "Installing ruvon-sdk from local wheel…");
  await micropip.install(RUVON_SDK_WHEEL);
  log("info", "ruvon-sdk installed");
  progress("micropip", 62);

  // Install ruvon-edge from local wheel.
  // Note: micropip cannot parse extras on local ./path.whl specs, so install base wheel directly.
  log("info", "Installing ruvon-edge from local wheel…");
  await micropip.install(RUVON_WHEEL);
  log("info", "ruvon-edge installed");
  progress("micropip", 65);

  // Install ruvon-swarm — provides real step functions + state models.
  // NOT in _RUNTIME_STUBS: we want the real Python code running.
  log("info", "Installing ruvon-swarm from local wheel…");
  await micropip.install(RUVON_SWARM_WHEEL);
  log("info", "ruvon-swarm installed");
  progress("micropip", 70);
}

// ── Step 4: Start RuvonEdgeAgent ──────────────────────────────────────────────
async function startAgent() {
  progress("agent", 75);
  log("info", "Starting RuvonEdgeAgent…");

  const agentId = "swarm-studio-" + Math.random().toString(36).slice(2, 8);

  // Write the DroneCommand YAML (now using ruvon_swarm package paths) to Pyodide FS
  pyodide.FS.writeFile("/home/pyodide/drone_command.yaml", DRONE_COMMAND_YAML);

  await pyodide.runPythonAsync(`
import sys, yaml, logging, warnings
sys.path.insert(0, "/home/pyodide")

# Suppress expected-in-demo stderr noise:
# 1. Pydantic model_versions protected-namespace warning (fixed in ruvon-sdk but guard here too)
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")
# 2. Config/sync pull errors (no cloud server in demo) — already caught, just noisy
logging.getLogger("ruvon_edge.config_manager").setLevel(logging.CRITICAL)
logging.getLogger("ruvon_edge.sync_manager").setLevel(logging.CRITICAL)
logging.getLogger("ruvon_edge.transport").setLevel(logging.CRITICAL)
logging.getLogger("ruvon_edge.agent").setLevel(logging.WARNING)

from ruvon_edge.platform.pyodide import PyodidePlatformAdapter
from ruvon_edge.implementations.persistence.pyodide_sqlite import PyodideSQLiteProvider
from ruvon_edge.agent import RuvonEdgeAgent
from ruvon_edge.models import DeviceConfig

_adapter     = PyodidePlatformAdapter(default_headers={})
_persistence = PyodideSQLiteProvider(db_name="ruvon_swarm_studio")

_agent = RuvonEdgeAgent(
    device_id=${JSON.stringify(agentId)},
    cloud_url="http://localhost:0",
    api_key="demo",
    db_path=":memory:",
    platform_adapter=_adapter,
    persistence_provider=_persistence,
)
await _agent.start()

# Register workflows with config_manager and workflow_builder.
# ruvon_swarm step functions are imported directly from the installed package.
if _agent.config_manager._current_config is None:
    _agent.config_manager._current_config = DeviceConfig(version="demo")

for _wf_name, _wf_path in [
    ("DroneCommand", "/home/pyodide/drone_command.yaml"),
]:
    _wf_raw  = open(_wf_path).read()
    _wf_dict = yaml.safe_load(_wf_raw)
    _agent.config_manager._current_config.workflows[_wf_name] = _wf_dict
    _agent.workflow_builder.workflow_registry[_wf_name] = {
        "type": _wf_name,
        "_yaml_content": _wf_raw,
    }

print("RuvonEdgeAgent started:", ${JSON.stringify(agentId)})
`);

  agentReady = true;
  progress("agent", 100);
  log("info", "RuvonEdgeAgent ready");
  self.postMessage({ type: "READY", agentId });
}

// ── Execute a workflow ────────────────────────────────────────────────────────
async function executeCommand(command, reqId, preset, globalCount) {
  if (!agentReady) {
    self.postMessage({ type: "ERROR", message: "Agent not ready" });
    return;
  }

  // Generate a workflow ID immediately so we can start reporting steps
  const workflowId = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,8).toUpperCase();
  self.postMessage({ type: "WORKFLOW_STARTED", workflowId, reqId });

  // Simulate per-step progress (real step hooks would require deeper integration)
  let stepNum = 0;
  const stepInterval = setInterval(() => {
    if (stepNum < STEP_NAMES.length) {
      self.postMessage({
        type: "STEP_COMPLETED",
        step:       STEP_NAMES[stepNum],
        stepNum:    stepNum + 1,
        totalSteps: STEP_NAMES.length,
        workflowId,
      });
      stepNum++;
    }
  }, 300);

  try {
    const input = { command };
    if (preset)      input.preset       = preset;
    if (globalCount) input.global_count = globalCount;
    const inputJson = JSON.stringify(input);
    const resultJson = await pyodide.runPythonAsync(`
import json
_r = await _agent.execute_workflow(
    "DroneCommand",
    json.loads(${JSON.stringify(inputJson)})
)
json.dumps(_r if _r else {}, default=str)
`);

    clearInterval(stepInterval);

    // Ensure all steps reported
    for (; stepNum < STEP_NAMES.length; stepNum++) {
      self.postMessage({
        type: "STEP_COMPLETED",
        step: STEP_NAMES[stepNum], stepNum: stepNum+1, totalSteps: STEP_NAMES.length, workflowId,
      });
    }

    const result = JSON.parse(resultJson || "{}");

    // Log to in-memory glass box
    _commandLog.push({ workflowId, command, ts: Date.now(), result });
    if (_commandLog.length > 200) _commandLog.shift();

    self.postMessage({ type: "RESULT", result, workflowId, reqId });

  } catch (err) {
    clearInterval(stepInterval);
    log("error", String(err));
    self.postMessage({ type: "ERROR", message: String(err), reqId });
  }
}

// ── Glass Box log query ───────────────────────────────────────────────────────
function queryLog(droneId, limit, reqId) {
  // Return recent entries — in this demo all commands apply to the whole swarm
  const entries = _commandLog.slice(-limit).map(e => ({
    workflowId: e.workflowId,
    command:    e.command,
    ts:         e.ts,
  }));
  self.postMessage({ type: "LOG_RESULT", droneId, entries: entries.reverse(), reqId });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === "INIT") {
      await initWaSqlite();
      await initPyodide();
      await installRuvonEdge();
      await startAgent();
    } else if (type === "EXECUTE") {
      await executeCommand(e.data.command, e.data.reqId, e.data.preset, e.data.global_count);
    } else if (type === "QUERY_LOG") {
      queryLog(e.data.droneId, e.data.limit ?? 3, e.data.reqId);
    } else if (type === "STOP") {
      if (agentReady) {
        await pyodide.runPythonAsync("await _agent.stop()").catch(() => {});
        agentReady = false;
      }
    }
  } catch (err) {
    log("error", String(err));
    self.postMessage({ type: "ERROR", message: String(err) });
  }
};
