"""
ruvon_swarm.state_models — Pydantic state models for swarm workflows.
"""

from __future__ import annotations
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class DroneCommandState(BaseModel):
    """State for the simple DroneCommand workflow (direct command execution)."""
    raw_input:     str  = ""
    parsed_action: dict = Field(default_factory=dict)
    is_valid:      bool = False
    log_entry:     str  = ""
    result:        dict = Field(default_factory=dict)
    error:         str  = ""


class SwarmFormationState(BaseModel):
    """State for the SwarmFormation workflow (intent-based formation broadcast)."""
    # Input fields
    raw_input:    str  = ""
    preset:       str  = "circle"
    is3d:         bool = False
    global_count: int  = 64
    # Built by build_intent step
    seed:         int  = 0
    intent:       dict = Field(default_factory=dict)
    # Validation
    is_valid:     bool = False
    validation_error: str = ""
    # Execution result
    status:       str  = ""
    log_entry:    str  = ""
    error:        str  = ""


class SwarmHealthState(BaseModel):
    """State for the SwarmHealth workflow (telemetry + battery checks)."""
    drone_count:       int   = 0
    avg_battery:       float = 100.0
    min_battery:       float = 100.0
    low_battery_count: int   = 0
    avg_cpu_load:      float = 0.0
    health_score:      float = 1.0
    alert:             str   = ""
    telemetry:         dict  = Field(default_factory=dict)
    status:            str   = ""
