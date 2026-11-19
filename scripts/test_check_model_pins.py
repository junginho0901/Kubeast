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
                           ("gpt-4o-mini", "with its date"), ("gpt-4", "with its date"), ("gpt-6", "_OPENAI_OWN_SNAPSHOT"), ("gpt-4o-mini-1234", "with its date"), ("gpt-6-luna-2026", "with its date"), ("gpt-5.5", "with its date"), ("gpt-4o-mini-tts", "with its date"), ("o3-mini", "with its date"),
                           ("gemini-2.5-flash", "no pin rule"), ("llama3.1:8b", "no pin rule"), ("", "empty")]:
            with self.subTest(model=model):
                self.assertIn(why, pins.why_not_pinned(model) or "pinned")


class ThisTree(unittest.TestCase):
    def test_every_default_is_found_and_pinned(self):
        self.assertEqual(pins.check(), [])

    def copy(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="model-pins-"))
        self.addCleanup(shutil.rmtree, root)
        for rel in [entry[0] for entry in pins.DEFAULTS] + [pins.CATALOG]:
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(pins.ROOT / rel, root / rel)
        return root

    def test_an_alias_in_a_default_fails(self):
        root = self.copy()
        values = root / "helm/kubeast/values.yaml"
        text = values.read_text(encoding="utf-8")
        pattern = next(e[1] for e in pins.DEFAULTS if e[0] == "helm/kubeast/values.yaml")
        found = re.search(pattern, text)
        values.write_text(text[:found.start(1)] + "gpt-4o-mini" + text[found.end(1):], encoding="utf-8")
        self.assertEqual(pins.check(root), ["helm/kubeast/values.yaml: chart ai.model 'gpt-4o-mini' is not pinned (an OpenAI alias: write the snapshot with its date (or, when OpenAI lists the ID as its own snapshot, add it to _OPENAI_OWN_SNAPSHOT))"])

    def test_the_chart_pattern_stays_inside_the_ai_block(self):
        root = self.copy()
        values = root / "helm/kubeast/values.yaml"
        text = values.read_text(encoding="utf-8")
        pattern = next(e[1] for e in pins.DEFAULTS if e[0] == "helm/kubeast/values.yaml")
        found = re.search(pattern, text)
        values.write_text(text[:found.start(0)] + 'ai:\n  enabled: true\nnext:\n  model: "gpt-4o-mini-2024-07-18"\n' + text[found.end(0):], encoding="utf-8")
        self.assertIn("chart ai.model not found", "".join(pins.check(root)))

    def test_the_setup_pages_model_is_an_entry_of_its_list(self):
        model = pins.read_default(next(e for e in pins.DEFAULTS if e[0].endswith("SetupAIModelPage.tsx")))
        self.assertIn(f"name: '{model}'", (pins.ROOT / pins.CATALOG).read_text(encoding="utf-8"))

    def test_the_install_script_may_name_its_model_through_a_variable(self):
        root = self.copy()
        script = root / "install-docker.sh"
        text = script.read_text(encoding="utf-8")
        line = next(ln for ln in text.splitlines() if ln.startswith("OPENAI_MODEL="))
        for value, problems in (("${MODEL:-gpt-6-luna}", 0), ("${MODEL:-gpt-4o-mini}", 1)):
            with self.subTest(value=value):
                script.write_text(text.replace(line, f"OPENAI_MODEL={value}", 1), encoding="utf-8")
                self.assertEqual(len(pins.check(root)), problems)

    def setup_entry(self):
        return next(e for e in pins.DEFAULTS if e[0].endswith("SetupAIModelPage.tsx"))

    def on_the_catalog(self, root: Path) -> Path:
        """The copy's setup page starting at its list's first entry, as #924 writes it."""
        page = root / "frontend/src/pages/setup/SetupAIModelPage.tsx"
        text = page.read_text(encoding="utf-8")
        if "useState(() => getDefaultModel('openai'))" not in text:
            line = next(ln for ln in text.splitlines() if "const [aiModel, setAiModel] = useState(" in ln)
            page.write_text(text.replace(line, "  const [aiModel, setAiModel] = useState(() => getDefaultModel('openai'))", 1), encoding="utf-8")
        return root / pins.CATALOG

    def first_openai_entry(self, catalog: Path, head: str) -> None:
        listed = catalog.read_text(encoding="utf-8")
        at = listed.index("id: 'openai',")
        models = listed.index("models: [", at) + len("models: [")
        catalog.write_text(listed[:models] + head + listed[models:], encoding="utf-8")

    def test_the_setup_page_may_start_at_its_lists_first_entry(self):
        for model, problems in (("gpt-6-luna", 0), ("gpt-5.5", 1)):
            with self.subTest(model=model):
                root = self.copy()
                catalog = self.on_the_catalog(root)
                self.first_openai_entry(catalog, f"\n      {{ name: '{model}', functionCalling: true }},")
                self.assertEqual(pins.read_default(self.setup_entry(), root), model)
                self.assertEqual(len(pins.check(root)), problems)

    def test_comment_lines_before_the_first_entry_are_passed_over(self):
        root = self.copy()
        catalog = self.on_the_catalog(root)
        self.first_openai_entry(catalog, "\n      // the models OpenAI keeps past 2027 (read 2026-11-15); some are left out:\n"
                                         "      // they take no tools in Chat Completions.\n      { name: 'gpt-6-luna', functionCalling: true },")
        self.assertEqual(pins.read_default(self.setup_entry(), root), "gpt-6-luna")
        self.assertEqual(pins.check(root), [])

    def test_a_list_it_cannot_read_is_not_found_rather_than_another_providers(self):
        for change in (
            lambda t: t.replace("return prov?.models[0]?.name ?? ''", "return prov?.models.find((m) => !m.note)?.name ?? ''", 1),
            lambda t: t.replace("models: [", "models: OPENAI_MODELS,\n    legacy: [", 1),
        ):
            with self.subTest(change=change):
                root = self.copy()
                catalog = self.on_the_catalog(root)
                catalog.write_text(change(catalog.read_text(encoding="utf-8")), encoding="utf-8")
                self.assertIsNone(pins.read_default(self.setup_entry(), root))
                self.assertIn("first-run setup page model not found", "".join(pins.check(root)))
