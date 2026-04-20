"""
ruvon-swarm — Swarm orchestration workflows for the Ruvon Private Fog Network.

Provides:
- SwarmFormationState, DroneCommandState, SwarmHealthState
- Step functions: parse_command, validate_formation, build_intent, execute_formation, log_formation
- Step functions: record_telemetry, check_battery_health, route_swarm_command
- Workflow YAMLs: DroneCommand, SwarmFormation, SwarmHealth
- Mulberry32 PRNG (bitwise-identical to JS implementation in formations.js / formations_3d.js)
"""

__version__ = "0.1.1"
