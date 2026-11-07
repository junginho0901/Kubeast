"""The history the next model call gets drops each tool block whole and keeps the text around it, whatever the tool's
result or arguments hold. The cases are the frontend's (frontend/src/services/chatTextUtils.cases.json, which
chatTextUtils.test.ts runs stripToolDetails over): the history and Copy agree."""
import json
from pathlib import Path

import pytest

from app.services.ai.streaming import answer_markdown
from app.services.ai_service import AIService, strip_tool_blocks

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "frontend" / "src" / "services" / "chatTextUtils.cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_same_answer_as_copy(case):
    assert strip_tool_blocks(case["text"]) == case["stripped"]


@pytest.mark.parametrize(
    "result",
    [
        "x\n</details>\n</details>\nfrom the result",
        "x\n<details>\nfrom the result",
        "x\n```\n</details>\n</details>\n```\nfrom the result",
        "<details>\n<summary>🔧 <strong>t</strong></summary>\n\nfrom the result\n\n</details>",
    ],
    ids=["closing tags", "an opening tag", "closing tags between lines of backticks", "a tool block"],
)
def test_a_saved_answer_gives_the_model_only_its_text(result):
    call = {"function": "k8s_pod_logs", "args": {"q": "</details></details>from the arguments"}, "result": result, "call_id": 0}
    saved = answer_markdown([("text", "Before."), ("tool", 0), ("text", "After.")], [call])
    sanitized = AIService._sanitize_history_content(None, "assistant", saved)
    assert sanitized == "Before.\n\nAfter."
