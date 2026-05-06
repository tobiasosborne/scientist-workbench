"""bench/_corpus/oracle — solve-epic golden-master oracle infrastructure.

Per ADR-0019, every solve-tier bench admits a golden case iff at least
two of three oracles (Wolfram, SymPy, SageMath) agree on the answer
modulo the verifier's mathematical-invariant equivalence relation.
This package implements the three-oracle stack and the per-kind
agreement layer.

Public surface:
    wolfram_query(code, timeout=30)        -> {'status', 'result'|'reason'}
    sympy_query(operation, *args, timeout) -> {'status', 'result'|'reason'}
    agree(a, b, kind)                      -> bool

Reference: docs/adr/0019-solve-bench-discipline.md, sections 3 + 6.
"""
try:
    from .wolfram import wolfram_query
    from .sympy_bridge import sympy_query
    from .agreement import agree
except ImportError:
    from wolfram import wolfram_query
    from sympy_bridge import sympy_query
    from agreement import agree

__all__ = ["wolfram_query", "sympy_query", "agree"]
