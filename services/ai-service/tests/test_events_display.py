"""The chat's table of k8s_get_events: the list as before, and the newest part of a longer one with its note."""
import json

from app.services.ai.formatters import _format_k8s_get_events_display

EVENT = {"namespace": "bulk", "type": "Warning", "reason": "BackOff", "message": "restarting",
         "object": {"kind": "Pod", "name": "web-1"}, "last_timestamp": "2026-10-30T04:00:00Z", "count": 3}


def test_a_list_is_a_table():
    out = _format_k8s_get_events_display(json.dumps([EVENT]))
    assert "BackOff" in out and "Pod/web-1" in out and "NAMESPACE" in out


def test_the_newest_part_of_a_longer_list_keeps_its_note():
    note = "the newest 1 of 76604 events, newest first; narrow with kind and name, or field_selector type=Warning"
    out = _format_k8s_get_events_display(json.dumps({"events": [EVENT], "total": 76604, "shown": 1, "note": note}))
    assert "BackOff" in out and out.rstrip().endswith(note)
    assert _format_k8s_get_events_display(json.dumps({"status": "too_large"})) is None
