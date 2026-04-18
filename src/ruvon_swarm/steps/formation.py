"""
ruvon_swarm.steps.formation — Step functions for the SwarmFormation workflow.

Step pipeline:
  ParseCommand → ValidateFormation → BuildIntent → LogFormation → ExecuteFormation

The key step is BuildIntent: it derives a deterministic seed from the workflow ID,
constructs the intent packet that the JS layer will broadcast to all follower tabs,
and stores it in state.intent.  The JS layer reads result["intent"] from RESULT and
calls _broadcastFormationIntent(preset, is3d, seed, global_count).
"""

from __future__ import annotations

import json
import time
from typing import Any

from ruvon_swarm.state_models import SwarmFormationState

VALID_PRESETS_3D = frozenset({"sphere", "helix", "dna", "torus", "wave", "vortex", "cube", "ruvon3d"})
VALID_PRESETS_2D = frozenset({
    "circle", "heart", "horse", "birds", "waterfall", "spiral",
    "diamond", "ruvon", "star", "triangle", "cross", "arrow",
    "hexagon", "smiley", "lightning", "rocket",
})
VALID_PRESETS = VALID_PRESETS_3D | VALID_PRESETS_2D


def parse_command(state: SwarmFormationState, context: Any, **kwargs: Any) -> dict:
    """
    Parse a raw text command into a (preset, is3d, global_count) triple.

    The caller may pass kwargs: command, preset, is3d, global_count.
    When only raw text is provided (e.g. "sphere formation with 128 drones"),
    the text is scanned for known preset names and a count keyword.
    """
    raw = kwargs.get("command", state.raw_input or "").strip()
    # Only use state.preset as fallback if it was not the Pydantic default ("circle")
    # so that raw-text scanning can override it.
    _explicit_preset = kwargs.get("preset")
    preset = _explicit_preset or ""
    is3d = bool(kwargs.get("is3d", state.is3d))
    global_count = int(kwargs.get("global_count", state.global_count or 64))

    # If no preset was explicitly supplied, scan raw text for a known preset name
    if not preset and raw:
        raw_lower = raw.lower()
        for name in sorted(VALID_PRESETS, key=len, reverse=True):  # longest match first
            if name in raw_lower:
                preset = name
                break

    preset = preset or "circle"

    # Auto-detect 3D from preset name
    if preset in VALID_PRESETS_3D:
        is3d = True
    elif preset in VALID_PRESETS_2D:
        is3d = False

    # Extract a count from raw text if not explicitly supplied (e.g. "128 drones")
    if not kwargs.get("global_count") and raw:
        import re
        m = re.search(r'\b(\d+)\b', raw)
        if m:
            candidate = int(m.group(1))
            if 1 <= candidate <= 100_000:
                global_count = candidate

    return {
        "raw_input":    raw or preset,
        "preset":       preset,
        "is3d":         is3d,
        "global_count": max(1, global_count),
    }


def validate_formation(state: SwarmFormationState, context: Any, **kwargs: Any) -> dict:
    """Validate that the preset is known and global_count is sane."""
    if state.preset not in VALID_PRESETS:
        return {
            "is_valid":         False,
            "validation_error": f"Unknown preset '{state.preset}'. Valid: {sorted(VALID_PRESETS)}",
        }
    if state.global_count < 1 or state.global_count > 100_000:
        return {
            "is_valid":         False,
            "validation_error": f"global_count {state.global_count} out of range [1, 100000]",
        }
    return {"is_valid": True, "validation_error": ""}


def build_intent(state: SwarmFormationState, context: Any, **kwargs: Any) -> dict:
    """
    Derive a deterministic seed from the workflow UUID and build the intent packet.

    The seed is derived from the first 4 bytes of the workflow ID so that
    any tab receiving this intent packet and using mulberry32(seed) will
    produce the *exact same* point cloud as every other tab.

    Returns:
        intent dict consumed by JS _broadcastFormationIntent()
    """
    if not state.is_valid:
        return {"status": "skipped_invalid", "intent": {}}

    # Derive seed from workflow ID bytes (first 4 bytes → big-endian uint32)
    try:
        wf_id = context.workflow_id
        if hasattr(wf_id, "bytes"):
            seed_bytes = wf_id.bytes[:4]
        else:
            import uuid as _uuid
            seed_bytes = _uuid.UUID(str(wf_id)).bytes[:4]
        seed = int.from_bytes(seed_bytes, "big") or 1  # never 0
    except Exception:
        # Fallback: time-based seed
        seed = int(time.time() * 1000) & 0x7FFFFFFF or 1

    intent = {
        "preset":        state.preset,
        "is3d":          state.is3d,
        "global_count":  state.global_count,
        "seed":          seed,
        "transition_ms": 3000,
    }
    return {"seed": seed, "intent": intent, "status": "intent_ready"}


def log_formation(state: SwarmFormationState, context: Any, **kwargs: Any) -> dict:
    """Fire-and-forget: write a glass-box audit entry."""
    entry = json.dumps({
        "workflow_id": str(context.workflow_id),
        "preset":      state.preset,
        "is3d":        state.is3d,
        "global_count": state.global_count,
        "seed":        state.seed,
        "ts":          time.time(),
    })
    return {"log_entry": entry}


def execute_formation(state: SwarmFormationState, context: Any, **kwargs: Any) -> dict:
    """
    Final step — confirm the intent is ready for broadcast.

    The JS layer is responsible for the actual broadcast; this step simply
    records the outcome so the workflow has a clean COMPLETED status.
    """
    if not state.is_valid:
        return {"status": "failed", "error": state.validation_error}
    return {
        "status": "executed",
        "result": {
            "workflow_id": str(context.workflow_id),
            "preset":      state.preset,
            "seed":        state.seed,
            "intent":      state.intent,
        },
    }
