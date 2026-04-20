"""
test_mulberry32.py — Verifies the Python mulberry32 PRNG is deterministic and
documents the canonical output sequences for cross-language parity checking.

JS PARITY VERIFICATION
======================
To confirm these values match the JavaScript implementation, run in a browser console:

    function mulberry32(seed) {
      return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // seed = 42891
    const rng = mulberry32(42891);
    JSON.stringify([...Array(10)].map(() => rng()))

    // Expected (matching Python output below):
    // [0.8388469694182277, 0.3226507315412164, 0.6466998420655727,
    //  0.7424083433579654, 0.47925661434419453, 0.5334634461905807,
    //  0.15422679809853435, 0.17913941014558077, 0.9634757104795426,
    //  0.9868875795509666]

The key invariant: for any given 32-bit seed, Python and JS must produce
identical float64 values to full double precision.
"""

import pytest
from ruvon_swarm.utils import mulberry32


# ── Canonical reference sequences (generated from Python, verified deterministic)
# ── Cross-language JS verification: see browser snippet in module docstring ──────

# seed = 42891  (primary reference seed, used in documentation)
EXPECTED_42891 = [
    0.8388469694182277,
    0.3226507315412164,
    0.6466998420655727,
    0.7424083433579654,
    0.47925661434419453,
    0.5334634461905807,
    0.15422679809853435,
    0.17913941014558077,
    0.9634757104795426,
    0.9868875795509666,
]

# seed = 0  (degenerate / zero-seed case)
EXPECTED_0 = [
    0.26642920868471265,
    0.0003297457005828619,
    0.2232720274478197,
    0.1462021479383111,
    0.46732782293111086,
]

# seed = 0xCAFEBABE (used in formation intent packets)
EXPECTED_CAFEBABE = [
    0.5782299907878041,
    0.9793111204635352,
    0.7408307811710984,
    0.29601835855282843,
    0.1459375221747905,
]


def _collect(seed: int, n: int) -> list[float]:
    rng = mulberry32(seed)
    return [rng() for _ in range(n)]


class TestMulberry32Determinism:
    def test_seed_42891_first_10_values(self):
        """Canonical reference sequence — must be stable across Python versions."""
        got = _collect(42891, 10)
        for i, (g, e) in enumerate(zip(got, EXPECTED_42891)):
            assert g == e, f"value[{i}]: got {g!r}, expected {e!r}"

    def test_seed_zero(self):
        got = _collect(0, 5)
        for i, (g, e) in enumerate(zip(got, EXPECTED_0)):
            assert g == e, f"value[{i}]: got {g!r}, expected {e!r}"

    def test_seed_cafebabe(self):
        """Seed used in formation intent packets (Date.now() ^ rng → similar range)."""
        got = _collect(0xCAFEBABE, 5)
        for i, (g, e) in enumerate(zip(got, EXPECTED_CAFEBABE)):
            assert g == e, f"value[{i}]: got {g!r}, expected {e!r}"

    def test_values_in_unit_interval(self):
        rng = mulberry32(99999)
        for _ in range(1000):
            v = rng()
            assert 0.0 <= v < 1.0, f"value {v!r} outside [0, 1)"

    def test_independent_instances_do_not_share_state(self):
        """Two rng functions created from the same seed must produce identical sequences."""
        a = mulberry32(12345)
        b = mulberry32(12345)
        for _ in range(20):
            assert a() == b()

    def test_different_seeds_produce_different_sequences(self):
        seq_a = _collect(1, 10)
        seq_b = _collect(2, 10)
        assert seq_a != seq_b

    def test_large_seed_is_masked_to_32_bits(self):
        """Seeds beyond 32 bits are masked — same as JS `seed | 0` semantics."""
        # 0xCAFEBABE & 0xFFFFFFFF == 0xCAFEBABE (already 32-bit)
        # 0xDEADBEEF_CAFEBABE & 0xFFFFFFFF == 0xCAFEBABE
        seq_a = _collect(0xCAFEBABE, 5)
        seq_b = _collect(0xDEADBEEF_CAFEBABE, 5)
        assert seq_a == seq_b

    def test_long_run_stays_bounded(self):
        """No integer overflow or NaN after many iterations."""
        rng = mulberry32(777)
        vals = [rng() for _ in range(100_000)]
        assert all(0.0 <= v < 1.0 for v in vals)
        assert len(set(vals)) > 90_000  # basic uniformity check — should not degenerate
