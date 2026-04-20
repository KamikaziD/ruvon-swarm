# Ruvon Swarm Studio 3D

> **100,000 agents · 0 servers · total sovereignty**
>
> Every browser tab IS a node. 64 ruvon-edge agents per tab. No cloud. No signaling server. Pure device mesh.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-00ff88?style=flat-square)](https://kamikazid.github.io/ruvon-swarm/examples/swarm_studio/)
[![ruvon-swarm](https://img.shields.io/badge/ruvon--swarm-0.1.0-00ff88?style=flat-square)](https://pypi.org/project/ruvon-swarm/)
[![ruvon-edge](https://img.shields.io/badge/ruvon--edge-0.1.2-00aaff?style=flat-square)](https://pypi.org/project/ruvon-edge/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

---

## What this is

A live browser demo that runs **64 fully simulated drones per tab** under the control of a real [`RuvonEdgeAgent`](https://pypi.org/project/ruvon-edge/) — the same Python runtime that powers payment terminals and IoT gateways — compiled to WebAssembly via [Pyodide](https://pyodide.org).

Open multiple tabs and they self-organize into a **private fog network**: elect a leader, divide the formation space, and render a unified swarm with each browser contributing its own 64-drone slice. Close any tab — remaining nodes re-elect a sovereign and recompute the fleet in under a second.

No server. No WebSocket backend. No cloud API. Every byte of computation stays on your device.

---

## Features

| Feature | Detail |
|---------|--------|
| **ruvon-edge in the browser** | Full `RuvonEdgeAgent` + YAML workflows via Pyodide/WASM |
| **BroadcastChannel mesh** | Same-device tab gossip with scored sovereign election |
| **Trystero/WebRTC** | Cross-device mesh via WebTorrent DHT — no signaling server |
| **WebGPU renderer** | Instanced drone meshes, LED glow, motion trails, rotor animation |
| **SharedArrayBuffer physics** | 4 parallel Web Workers, Reynolds flocking + PID altitude, zero serialization |
| **Inline physics fallback** | Automatic fallback to main-thread rAF loop when SAB unavailable |
| **Deterministic sync** | Broadcast seed + preset name (not coordinates); each tab computes its own slice |
| **Bundled Pyodide cache** | ~35 MB runtime stored in Cache Storage on first load — instant warm-up on refresh |
| **16 formations** | Sphere, Helix, DNA, Torus, Vortex, Wave, Cube, Ruvon-R, Star, and more |
| **NLP commands** | MiniLM cosine similarity → preset; escalates to wllama/Ollama for complex prompts |
| **Zero CO₂ overhead** | 92% less compute than cloud inference; HUD shows live green energy estimate |

---

## Quick start

### GitHub Pages (no install)

Visit the live demo:
```
https://kamikazid.github.io/ruvon-swarm/examples/swarm_studio/
```

On first load the service worker registers and the page reloads once. From then on — including page refresh — everything is served from cache. No CDN round-trip, no network after first load.

### Run locally

```bash
git clone https://github.com/KamikaziD/ruvon-swarm
cd ruvon-swarm/examples/swarm_studio
python serve.py          # http://localhost:8080
```

`serve.py` sets the COOP/COEP/CORP headers required for SharedArrayBuffer and serves the bundled `pyodide-cache/` directory locally. No pip installs needed beyond Python 3.9+.

**Cross-device testing:** open `http://<your-lan-ip>:8080` on two different devices. Trystero connects them peer-to-peer via WebRTC using WebTorrent DHT — no signaling server required.

---

## How to use the demo

1. Open in **Chrome or Edge** (WebGPU required)
2. Click **Launch Drones** — 64 drones fly to the default Ruvon-R formation; this tab is the *sovereign*
3. Copy the **Sovereign Link** from the top-left panel and open it in a second tab or on another device
4. Click **Join Formation** on the follower — the fleet expands to 128 drones, each tab renders its own slice
5. Add more tabs from the same link — each contributes another 64-drone squad
6. Use the **3D Formations** panel: Sphere, Helix, DNA, Torus, Vortex, Wave, Cube
7. Type in the **Command** box: *"form a sphere"*, *"scatter"*, *"land all"*
8. Close the sovereign tab — the mesh re-elects a new leader in under one second

---

## Architecture

```
BROWSER TAB (sovereign)                      BROWSER TAB (follower N)
┌────────────────────────────────┐           ┌────────────────────────────────┐
│  RuvonEdgeAgent (Pyodide/WASM) │           │  RuvonEdgeAgent (Pyodide/WASM) │
│  SwarmFormation workflow       │           │  SwarmFormation workflow       │
├────────────────────────────────┤           ├────────────────────────────────┤
│  mesh_brain.js (Worker)        │◄─────────►│  mesh_brain.js (Worker)        │
│  BroadcastChannel gossip       │           │  gossip + election follower    │
│  Sovereign election (scored)   │           │  FORMATION_INTENT receiver     │
├────────────────────────────────┤           ├────────────────────────────────┤
│  physics_worker.js × 4 (SAB)  │           │  physics_worker.js × 4 (SAB)  │
│  Reynolds flocking + PID alt   │           │  Reynolds flocking + PID alt   │
│  ↳ fallback: inline rAF loop  │           │  ↳ fallback: inline rAF loop  │
├────────────────────────────────┤           ├────────────────────────────────┤
│  renderer_webgpu.js            │           │  renderer_webgpu.js            │
│  Instanced drone mesh          │           │  Ghost dots for remote squads  │
│  LED glow + trails             │           │  LED glow + trails             │
└────────────────────────────────┘           └────────────────────────────────┘
              │ BroadcastChannel (same-device) · Trystero/WebRTC (cross-device)
              └─────────────────────────────────────────────────────────────►
```

---

## File map

```
examples/swarm_studio/
  index.html              Main app shell + UI + formation control
  info.html               Architecture explainer
  serve.py                Local dev server (COOP/COEP headers, brotli)
  coi-serviceworker.js    COOP/COEP header injection + cache-first SW
  pyodide_worker.js       Pyodide boot, ruvon-edge install, SwarmFormation workflow runner
  mesh_brain.js           BroadcastChannel gossip, sovereign election, trystero relay
  drone_sim.js            2D Reynolds flocking, Hungarian assignment
  drone_sim_3d.js         3D PID altitude, pitch/roll, rotor spin, launch FSM
  formations.js           16 2D formation presets + canvas text/emoji rasterizer
  formations_3d.js        8 3D presets (sphere, helix, DNA, torus, wave, vortex…)
  physics_worker.js       SAB-slice physics (spawned ×4 per tab)
  renderer_webgpu.js      WebGPU instanced renderer, LED glow, trails, pickDrone
  camera.js               OrbitCamera: view/proj matrices, touch/mouse/wheel
  command_brain.js        MiniLM cosine similarity + ESCALATE to wllama/Ollama
  sidecar.js              Frame timing, LLM throttle, green energy calculation
  learning_loop.js        IndexedDB telemetry, FORM_WEIGHT / BATTERY_DRAIN tweaks
  storage.js              ULID + IndexedDB (performances, telemetry, tweaks)
  trystero-torrent.js     Bundled trystero WebTorrent DHT (cross-device WebRTC)
  pyodide-cache/          Bundled Pyodide 0.26.4 runtime (served locally / cached)
  ruvon_swarm-0.1.0-py3-none-any.whl   Local ruvon-swarm package wheel
  ruvon_sdk-0.1.2-py3-none-any.whl     Local ruvon-sdk package wheel
  ruvon_edge-0.1.2-py3-none-any.whl    Local ruvon-edge package wheel

src/ruvon_swarm/
  __init__.py             Package version (0.1.0)
  state_models.py         SwarmFormationState, SwarmHealthState Pydantic models
  steps/
    formation.py          parse_command, validate_formation, build_intent, execute_formation
    telemetry.py          record_telemetry, check_battery_health
    command_router.py     route_swarm_command
  utils.py                mulberry32 PRNG (bitwise-identical to JS implementation)
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Python runtime | [Pyodide](https://pyodide.org) 0.26.4 (CPython → WASM) |
| Workflow engine | [ruvon-edge](https://pypi.org/project/ruvon-edge/) 0.1.2 |
| Swarm package | [ruvon-swarm](https://pypi.org/project/ruvon-swarm/) 0.1.0 |
| Physics | Web Workers + SharedArrayBuffer (Reynolds flocking, PID) |
| Rendering | WebGPU — instanced meshes, compute shaders |
| Mesh (same-device) | BroadcastChannel |
| Mesh (cross-device) | [Trystero](https://github.com/dmotz/trystero) + WebTorrent DHT — serverless WebRTC |
| NLP | MiniLM (ONNX, in-browser) + wllama/Ollama (fallback) |
| Caching | Cache Storage via service worker (cache-first, same-origin) |
| PRNG | mulberry32 — bitwise-identical in JS and Python |

---

## Sovereignty election

Every tab broadcasts a capability vector (battery, CPU, RAM, task queue) every ~2 s. All pods score all peers and elect the highest scorer as sovereign.

- **FOUNDING_BIAS (+0.40):** the first tab opened stays sovereign while alive
- **HYSTERESIS (+0.30):** incumbent gets a score bonus — prevents flopping on minor score differences
- **Stable tiebreaker:** `(score DESC, pod_id ASC)` — all pods converge to the same winner
- **Instant GOODBYE:** closing a tab sends a synchronous BroadcastChannel message; re-election completes in < 1 s
- **Conflict resolution:** if two pods simultaneously claim sovereignty, the lower-ranking one yields immediately

---

## Deterministic formation sync

Formation changes broadcast a **seed + preset name** — not drone coordinates. Each tab independently computes its own index slice:

```javascript
// Tab with slot=1 calls:
spherePoint(64..127, globalCount)  // never touches slot 0's points
```

The [mulberry32](https://github.com/nicowillis/mulberry32) PRNG is implemented identically in JS and Python, so formation math is reproducible and validatable. Network traffic per formation change: ~200 bytes, regardless of fleet size.

---

## License

Apache-2.0 — see [LICENSE](LICENSE).

Built with [ruvon-edge](https://pypi.org/project/ruvon-edge/) · [WebGPU](https://gpuweb.github.io/gpuweb/) · [Pyodide](https://pyodide.org) · [Trystero](https://github.com/dmotz/trystero)
