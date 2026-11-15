#!/usr/bin/env python3
"""scripts/check-model-pins.py: which IDs are pinned snapshots, and that every default of this tree is found and pinned."""
from __future__ import annotations

import importlib.util
import re
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_model_pins", HERE / "check-model-pins.py")
pins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pins)


class PinRule(unittest.TestCase):
    def test_pinned_snapshots(self):
        for model in ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-opus-4-6", "claude-fable-5-1",
                      "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "gpt-4o-mini-2024-07-18", "o3-mini-2025-01-31", "gpt-4-0613",
                      "gpt-4-1106-preview", "claude-opus-4-10", "gpt-6-luna"]:
            with self.subTest(model=model):
                self.assertIsNone(pins.why_not_pinned(model))

    def test_aliases_and_unknown_providers(self):
        for model, why in [("claude-haiku-4-5", "dated ID"), ("claude-sonnet-4-5", "dated ID"), ("claude-3-5-haiku-latest", "latest"),
                           ("gpt-4o-mini", "with its date"), ("gpt-4", "with its date"), ("gpt-6", "_OPENAI_OWN_SNAPSHOT"), ("gpt-5.5", "with its date"), ("gpt-4o-mini-tts", "with its date"), ("o3-mini", "with its date"),
                           ("gemini-2.5-flash", "no pin rule"), ("llama3.1:8b", "no pin rule"), ("", "empty")]:
            with self.subTest(model=model):
                self.assertIn(why, pins.why_not_pinned(model) or "pinned")


class ThisTree(unittest.TestCase):
    def test_every_default_is_found_and_pinned(self):
        self.assertEqual(pins.check(), [])

    def copy(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="model-pins-"))
        self.addCleanup(shutil.rmtree, root)
        for rel, _pattern, _what in pins.DEFAULTS:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(pins.ROOT / rel, root / rel)
        return root

    def test_an_alias_in_a_default_fails(self):
        root = self.copy()
        values = root / "helm/kubeast/values.yaml"
        text = values.read_text(encoding="utf-8")
        pattern = next(p for rel, p, _what in pins.DEFAULTS if rel == "helm/kubeast/values.yaml")
        found = re.search(pattern, text)
        values.write_text(text[:found.start(1)] + "gpt-4o-mini" + text[found.end(1):], encoding="utf-8")
        self.assertEqual(pins.check(root), ["helm/kubeast/values.yaml: chart ai.model 'gpt-4o-mini' is not pinned (an OpenAI alias: write the snapshot with its date (or, when OpenAI lists the ID as its own snapshot, add it to _OPENAI_OWN_SNAPSHOT))"])

    def test_the_chart_pattern_stays_inside_the_ai_block(self):
        root = self.copy()
        values = root / "helm/kubeast/values.yaml"
        text = values.read_text(encoding="utf-8")
        pattern = next(p for rel, p, _what in pins.DEFAULTS if rel == "helm/kubeast/values.yaml")
        found = re.search(pattern, text)
        values.write_text(text[:found.start(0)] + 'ai:\n  enabled: true\nnext:\n  model: "gpt-4o-mini-2024-07-18"\n' + text[found.end(0):], encoding="utf-8")
        self.assertIn("chart ai.model not found", "".join(pins.check(root)))

    def test_the_setup_pages_model_is_an_entry_of_its_list(self):
        page = (pins.ROOT / "frontend/src/pages/setup/SetupAIModelPage.tsx").read_text(encoding="utf-8")
        pattern = next(p for rel, p, _what in pins.DEFAULTS if rel.endswith("SetupAIModelPage.tsx"))
        model = re.search(pattern, page).group(1)
        self.assertIn(f"name: '{model}'", (pins.ROOT / "frontend/src/constants/modelCatalog.ts").read_text(encoding="utf-8"))

    def test_a_default_that_moved_fails(self):
        root = self.copy()
        (root / "services/ai-service/app/config.py").write_text("OPENAI_MODEL = settings_default()\n", encoding="utf-8")
        problems = pins.check(root)
        self.assertEqual(len(problems), 1)
        self.assertIn("ai-service OPENAI_MODEL not found", problems[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
