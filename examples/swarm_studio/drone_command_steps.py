"""
drone_command_steps.py — ruvon-edge step functions for DroneCommand workflow.

Loaded into Pyodide via pyodide.FS.writeFile() before agent start.
Each function receives (state, context, **kwargs) and returns a dict
merged into workflow state.
"""

from pydantic import BaseModel
from typing import Any
import json


# ── State Model ───────────────────────────────────────────────────────────────

class DroneCommandState(BaseModel):
    raw_input: str = ""
    parsed_action: dict = {}
    is_valid: bool = False
    log_entry: str = ""
    result: dict = {}
    error: str = ""


# ── Step Functions ────────────────────────────────────────────────────────────

def parse_command(state: DroneCommandState, context: Any, **kwargs) -> dict:
    """
    ParseCommand — tokenise and normalise the incoming command string.
    Receives raw command text from kwargs["command"].
    """
    raw = kwargs.get("command", state.raw_input or "")
    raw = raw.strip()

    # Extract action hint if prefixed (e.g. "formation:sphere" or plain text)
    parsed = {"command": raw, "workflow_id": str(context.workflow_id)}
    if ":" in raw:
        parts = raw.split(":", 1)
        parsed["action"] = parts[0].strip()
        parsed["param"]  = parts[1].strip()
    else:
        parsed["action"] = "execute"
        parsed["param"]  = raw

    return {"raw_input": raw, "parsed_action": parsed}


def validate_command(state: DroneCommandState, context: Any, **kwargs) -> dict:
    """
    ValidateCommand — DECISION step.
    Commands are pre-validated by the LLM/MiniLM layer before reaching here,
    so we always proceed. Empty commands are silently allowed (no-op).
    """
    # DECISION steps can raise WorkflowJumpDirective to skip ahead;
    # we always continue to LogCommand → ExecuteCommand.
    return {"is_valid": True}


def log_command(state: DroneCommandState, context: Any, **kwargs) -> dict:
    """
    LogCommand — FIRE_AND_FORGET audit entry.
    Writes a structured record to the wa-sqlite log via context persistence.
    on_error: ignore — this step never blocks the main workflow.
    """
    entry = json.dumps({
        "workflow_id": str(context.workflow_id),
        "command": state.raw_input,
        "parsed": state.parsed_action,
        "valid": state.is_valid,
    })
    return {"log_entry": entry}


def execute_command(state: DroneCommandState, context: Any, **kwargs) -> dict:
    """
    ExecuteCommand — produce the final result payload.
    The main thread reads result.workflow_id to correlate UI updates.
    """
    result = {
        "workflow_id": str(context.workflow_id),
        "command": state.parsed_action,
        "status": "executed",
    }
    return {"result": result}
