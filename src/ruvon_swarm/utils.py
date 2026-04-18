"""
ruvon_swarm.utils — Shared utilities for swarm math.

mulberry32: Seeded PRNG that is bitwise-identical to the JavaScript
implementation in formations.js / formations_3d.js.  Use the same seed
on both sides and you get the exact same point cloud — guaranteed.
"""

from __future__ import annotations
from typing import Callable


def mulberry32(seed: int) -> Callable[[], float]:
    """
    Return a pseudo-random number generator seeded with *seed*.

    The generated sequence is bitwise-identical to the JS version:

        function mulberry32(seed) {
          return () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        }

    Usage::

        rng = mulberry32(42891)
        x = rng()   # first value
        y = rng()   # second value
    """
    _seed = [seed & 0xFFFFFFFF]

    def _next() -> float:
        s = (_seed[0] + 0x6D2B79F5) & 0xFFFFFFFF
        _seed[0] = s
        t = ((s ^ (s >> 15)) * (1 | s)) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t)) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return _next
