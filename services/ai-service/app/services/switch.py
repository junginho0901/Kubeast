"""One rule for reading an on/off switch from the environment, the same as Go's services/pkg/config.SwitchOn
(tests/fixtures/switch_cases.json holds the two equal): true, 1, on or yes in any case, with spaces around it, is on;
anything else, unset included, is off."""
from __future__ import annotations

import os
from typing import Optional

ON = frozenset({"true", "1", "on", "yes"})


def on(value: Optional[str]) -> bool:
    """Whether a switch's value turns it on."""
    return isinstance(value, str) and value.strip().lower() in ON


def env_on(name: str) -> bool:
    """Whether the environment variable ``name`` turns its switch on."""
    return on(os.getenv(name))
