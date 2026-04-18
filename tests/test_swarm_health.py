"""Tests for ruvon_swarm telemetry / health step functions."""

import pytest
from unittest.mock import MagicMock

from ruvon_swarm.state_models import SwarmHealthState
from ruvon_swarm.steps.telemetry import record_telemetry, check_battery_health


def _ctx():
    return MagicMock()


def _drones(batteries, cpu_loads=None):
    cpu_loads = cpu_loads or [0.2] * len(batteries)
    return [{"battery": b, "cpu_load": c} for b, c in zip(batteries, cpu_loads)]


# ── record_telemetry ──────────────────────────────────────────────────────────

def test_record_telemetry_basic():
    state = SwarmHealthState()
    drones = _drones([80, 60, 40])
    result = record_telemetry(state, _ctx(), drones=drones)
    assert result["drone_count"] == 3
    assert result["avg_battery"] == pytest.approx(60.0)
    assert result["min_battery"] == 40.0
    assert result["low_battery_count"] == 0  # all >= 20%


def test_record_telemetry_detects_low_battery():
    state = SwarmHealthState()
    drones = _drones([80, 15, 10])  # two below threshold
    result = record_telemetry(state, _ctx(), drones=drones)
    assert result["low_battery_count"] == 2


def test_record_telemetry_empty():
    state = SwarmHealthState()
    result = record_telemetry(state, _ctx(), drones=[])
    assert result["status"] == "no_data"
    assert result["drone_count"] == 0


# ── check_battery_health ──────────────────────────────────────────────────────

def test_check_health_all_healthy():
    state = SwarmHealthState(drone_count=4, avg_battery=80.0, min_battery=60.0,
                              low_battery_count=0)
    result = check_battery_health(state, _ctx())
    assert result["health_score"] == 1.0
    assert result["alert"] == ""


def test_check_health_warning():
    # 1 of 4 drones low → 25% exactly at CRITICAL_RATIO boundary
    state = SwarmHealthState(drone_count=4, avg_battery=50.0, min_battery=15.0,
                              low_battery_count=1)
    result = check_battery_health(state, _ctx())
    # 1/4 = 0.25 = CRITICAL_RATIO → not > threshold, but min < 20 → WARNING
    assert "WARNING" in result["alert"] or result["health_score"] < 1.0


def test_check_health_critical():
    # 3 of 4 drones low → 75% > CRITICAL_RATIO
    state = SwarmHealthState(drone_count=4, avg_battery=10.0, min_battery=5.0,
                              low_battery_count=3)
    result = check_battery_health(state, _ctx())
    assert result["health_score"] < 0.5
    assert "CRITICAL" in result["alert"]


def test_check_health_no_drones():
    state = SwarmHealthState(drone_count=0)
    result = check_battery_health(state, _ctx())
    assert result["health_score"] == 1.0
    assert result["alert"] == ""
