"""One rule for reading an on/off switch from the environment, the same as Go's services/pkg/config.SwitchOn
(tests/fixtures/switch_cases.json holds the two equal): true, 1, on or yes in any case, with spaces around it, is on;
anything else, unset included, is off."""
from __future__ import annotations

import os
from typing import Optional

ON = frozenset({"true", "1", "on", "yes"})
# The space Go's strings.TrimSpace takes off (unicode.IsSpace): str.strip() would also take off \x1c-\x1f.
GO_SPACE = " \t\n\v\f\r\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"


def on(value: Optional[str]) -> bool:
    """Whether a switch's value turns it on."""
    return isinstance(value, str) and value.strip(GO_SPACE).lower() in ON


def env_on(name: str) -> bool:
    """Whether the environment variable ``name`` turns its switch on."""
    return on(os.getenv(name))
