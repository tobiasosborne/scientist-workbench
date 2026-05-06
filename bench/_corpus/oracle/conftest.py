"""pytest configuration for the oracle agreement test suite.

`pytest_collection_modifyitems` MUST live in conftest.py (not the test
module) for pytest to discover it as a hook.

Skips `@pytest.mark.live_oracle` tests when WB_LIVE_ORACLE=0 in the
environment. This lets the bench-wide `bun run check` skip the slow
Wolfram-dependent tier on CI hosts where the kernel is not activated.
"""
import os
import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("WB_LIVE_ORACLE", "1") != "0":
        return
    skip_mark = pytest.mark.skip(reason="WB_LIVE_ORACLE=0 disables live Wolfram tests")
    for item in items:
        if "live_oracle" in item.keywords:
            item.add_marker(skip_mark)
