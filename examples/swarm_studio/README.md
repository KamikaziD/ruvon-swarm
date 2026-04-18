# Ruvon Swarm Studio — Browser Demo 4

> **Same mesh intelligence. Different application.**
> The coordination fabric that makes cross-border payments resilient, sovereign, and sustainable — now commanding 1 000 drones.

## What it demonstrates

| Ruvon primitive | In payments | In this demo |
|----------------|-------------|--------------|
| S(Vc) scoring | Rank payment processors by capacity | Rank drones by battery + position |
| Sovereign election | Coordinator for settlement routing | Coordinator for formation assignment |
| Help-push | Overloaded node signals peers | Low-battery drone signals for reassignment |
| SAF queue | Offline terminal buffers transactions | Partitioned drone buffers move commands |
| Task distribution | Sovereign assigns compute to workers | Sovereign assigns inference shards to tabs |
| Shared compute | — | Open a second tab → inference distributes |

## Running locally

```bash
python3 examples/browser_demo_4/serve.py   # default port 8081
# open http://localhost:8081
```

Requires Python 3.8+. No other dependencies.

## Try it

1. **Preset buttons** — click any formation; drones transition via Reynolds forces
2. **Custom intent** — type `"form a galaxy"` or `"make a waterfall"` and press Enter
   - Client-side Levenshtein fires instantly; MiniLM semantic model refines after ~1 s
3. **Fail 10%** — randomly offline drones; watch the swarm close the gaps
4. **Partition** — 30% of drones enter SAF mode; restore to drain queues
5. **Open a second tab** — Compute nodes counter turns green; intent queries distribute

## Architecture

```
Main Thread                          mesh_brain Worker
├── PixiJS canvas (renderer.js)      ├── Sovereign election
├── Drone fleet (drone_sim.js)       ├── Gossip heartbeats
├── Reynolds physics (60 fps)        ├── Task distribution
└── postMessage ↔ Worker             └── SAF relay

command_brain Worker                 BroadcastChannel mesh
├── MiniLM-L6-v2 (Tier 1, 23 MB)   └── Cross-tab coordination
└── wllama GGUF LLM (Tier 2)            (INFERENCE_SHARD tasks)
    SmolLM2 / Qwen2.5 / Nemotron
```

## Formations

`circle` · `heart` · `horse` · `birds` · `waterfall` · `spiral` · `diamond` · `ruvon`

Custom free-text is resolved by cosine similarity against sentence embeddings of each formation's description. Unknown intent falls back to `circle`.

## Performance targets

| Metric | Target |
|--------|--------|
| Drones at 60 fps | 1 000+ |
| Formation transition | < 2 s p95 |
| Sovereign failover | < 5 s |
| MiniLM load (cold) | < 5 s |
| MiniLM inference | < 200 ms cached |
