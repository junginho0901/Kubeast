"""The saved answer is the answer the chat showed, and a tool block is never read as code. The cases are the frontend's
(frontend/src/services/chatAnswer.cases.json, which chatStreamManager.test.ts runs the stream over): what the screen
drew, what was saved, Copy and the history the next model call gets all agree."""
import json
from pathlib import Path

import pytest

from app.services.ai.streaming import answer_markdown, tool_block_markdown
from app.services.ai_service import AIService, strip_tool_blocks

ANSWERS = json.loads(
    (Path(__file__).resolve().parents[3] / "frontend" / "src" / "services" / "chatAnswer.cases.json").read_text(encoding="utf-8")
)
CASES = ANSWERS["cases"]
IDS = [c["name"] for c in CASES]


def tool_call(call_id):
    return {"function": "t", "args": {}, "result": "r", "call_id": call_id}


def saved(case):
    parts = [tuple(part) for part in case["parts"]]
    return answer_markdown(parts, [tool_call(value) for kind, value in parts if kind == "tool"])


def test_the_block_of_the_cases_is_the_block_saved():
    assert tool_block_markdown(tool_call(0)) == ANSWERS["block"]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_the_saved_answer_is_the_one_on_screen(case):
    assert saved(case) == case["answer"].replace("{block}", ANSWERS["block"])


@pytest.mark.parametrize("case", [c for c in CASES if "stripped" in c], ids=[c["name"] for c in CASES if "stripped" in c])
def test_the_history_has_the_text_copy_has(case):
    assert strip_tool_blocks(saved(case)) == case["stripped"]
    assert AIService._sanitize_history_content(None, "assistant", saved(case)) == case["stripped"].strip()


def test_a_call_no_part_names_goes_below_the_code_block_it_follows():
    answer = answer_markdown([("text", "```\ncode"), ("text", "Last.")], [tool_call(0)])
    assert answer == f"```\ncode\n```\n\n{ANSWERS['block']}Last."


@pytest.mark.parametrize(
    "text, closing",
    [
        ("", None),
        ("plain", None),
        ("```\nclosed\n```", None),
        ("```", "```"),
        ("```bash", "```"),
        ("```\ncode", "```"),
        ("  ```\n  code", "  ```"),
        ("~~~~ text\ncode", "~~~~"),
        ("````\n```", "````"),
        ("- a\n  ```\n  code\nless indented", None),
        ("- a\n  ```\n  code\nless indented\n~~~\nmore", "~~~"),
    ],
)
def test_the_line_that_closes_what_a_text_leaves_open(text, closing):
    closed = f"{text}\n{closing}" if closing else text
    answer = answer_markdown([("text", text), ("tool", 0)], [tool_call(0)])
    assert answer == (f"{closed}\n\n" if closed else "") + ANSWERS["block"]
