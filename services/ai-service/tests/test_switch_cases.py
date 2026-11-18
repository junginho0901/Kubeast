"""One rule for an on/off switch's value in Python and Go (fixtures/switch_cases.json; Go: services/pkg/config TestSwitchCases)."""
import json
from pathlib import Path

import pytest

from app.services import switch

CASES = json.loads((Path(__file__).parent / "fixtures" / "switch_cases.json").read_text())["cases"]


def test_the_fixture_holds_the_cases():
    assert len(CASES) >= 10


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_a_switch_value_reads_as_the_fixture_says(case, monkeypatch):
    assert switch.on(case["value"]) is case["on"]
    monkeypatch.setenv("KUBEAST_TEST_SWITCH", case["value"])
    assert switch.env_on("KUBEAST_TEST_SWITCH") is case["on"]


def test_an_unset_switch_is_off(monkeypatch):
    monkeypatch.delenv("KUBEAST_TEST_SWITCH", raising=False)
    assert switch.env_on("KUBEAST_TEST_SWITCH") is False and switch.on(None) is False
