"""
ruvon_swarm.steps.telemetry — Step functions for the SwarmHealth workflow.
"""

from __future__ import annotations
from typing import Any

from ruvon_swarm.state_models import SwarmHealthState

LOW_BATTERY_THRESHOLD = 20.0  # % below which a drone is "low battery"
CRITICAL_RATIO        = 0.25  # if more than 25% of drones are low, emit alert


def record_telemetry(state: SwarmHealthState, context: Any, **kwargs: Any) -> dict:
    """
    Aggregate drone telemetry passed in via kwargs["drones"].

    Expected: drones = [{"battery": float, "cpu_load": float, ...}, ...]
    """
    drones = kwargs.get("drones", [])
    if not drones:
        return {"status": "no_data", "drone_count": 0}

    batteries  = [float(d.get("battery", 100)) for d in drones]
    cpu_loads  = [float(d.get("cpu_load", 0))  for d in drones]
    low_count  = sum(1 for b in batteries if b < LOW_BATTERY_THRESHOLD)

    return {
        "drone_count":       len(drones),
        "avg_battery":       round(sum(batteries) / len(batteries), 2),
        "min_battery":       round(min(batteries), 2),
        "low_battery_count": low_count,
        "avg_cpu_load":      round(sum(cpu_loads) / len(cpu_loads), 3),
        "telemetry":         {"batteries": batteries, "cpu_loads": cpu_loads},
        "status":            "recorded",
    }


def check_battery_health(state: SwarmHealthState, context: Any, **kwargs: Any) -> dict:
    """
    Compute a health score and emit an alert if too many drones are low.

    Health score: 1.0 = all healthy, 0.0 = all critical.
    """
    if state.drone_count == 0:
        return {"health_score": 1.0, "alert": ""}

    low_ratio    = state.low_battery_count / state.drone_count
    health_score = round(1.0 - low_ratio, 3)

    alert = ""
    if low_ratio > CRITICAL_RATIO:
        alert = (
            f"CRITICAL: {state.low_battery_count}/{state.drone_count} drones "
            f"below {LOW_BATTERY_THRESHOLD}% battery (min={state.min_battery}%)"
        )
    elif state.min_battery < LOW_BATTERY_THRESHOLD:
        alert = f"WARNING: {state.low_battery_count} drone(s) low battery (min={state.min_battery}%)"

    return {"health_score": health_score, "alert": alert, "status": "checked"}
