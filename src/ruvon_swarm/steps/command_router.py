"""
ruvon_swarm.steps.command_router — Routes a raw swarm command to the right workflow.
"""

from __future__ import annotations
from typing import Any

_FORMATION_KEYWORDS = {"formation", "form", "fly", "move", "go", "preset", "shape"}
_HEALTH_KEYWORDS    = {"health", "battery", "status", "telemetry", "check", "report"}


def route_swarm_command(state: Any, context: Any, **kwargs: Any) -> dict:
    """
    Inspect raw_input and decide which downstream workflow to trigger.

    Returns:
        route: "formation" | "health" | "unknown"
    """
    raw = (kwargs.get("command", "") or getattr(state, "raw_input", "") or "").lower()
    words = set(raw.split())

    if words & _FORMATION_KEYWORDS:
        return {"route": "formation", "status": "routed"}
    if words & _HEALTH_KEYWORDS:
        return {"route": "health", "status": "routed"}
    return {"route": "unknown", "status": "routed"}
