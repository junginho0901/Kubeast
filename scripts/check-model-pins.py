#!/usr/bin/env python3
"""Every default model Kubeast ships is written as a pinned snapshot ID, so the model behind a default does not change
under an install (docs/development.md "Default models").

A default is a model an install, the first-run setup page or a dev script uses when nobody chose one (the model picker's
other entries are a list to choose from, not checked here). A place its pattern no longer finds fails
too, so a default that moved is added here instead of going unchecked. Claude IDs from the 4.6 generation on are their
own snapshot, earlier ones only with their date; OpenAI IDs with their date, or an ID OpenAI lists as its own snapshot;
"latest" never; another provider needs a rule.

  python3 -I scripts/check-model-pins.py          # exit 1 when a default is not pinned or not found
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CATALOG = "frontend/src/constants/modelCatalog.ts"


def catalog_first(provider: str, root: Path) -> str | None:
    """The first model the screens' list gives a provider (modelCatalog.ts getDefaultModel), or None."""
    text = (root / CATALOG).read_text(encoding="utf-8")
    at = text.find(f"id: '{provider}',")
    models = text.find("models: [", at) if at >= 0 else -1
    first = re.match(r"\s*\{ name: '([^']+)'", text[models + len("models: ["):]) if models >= 0 else None
    return first.group(1) if first else None


def _setup_model(found: re.Match, root: Path) -> str | None:
    return found.group(1) if found.group(1) is not None else catalog_first(found.group(2), root)


# (file, pattern whose first matched group is the model, what the default is[, how a match names the model])
DEFAULTS = [
    ("helm/kubeast/values.yaml", r'(?m)^ai:\n(?:(?: .*|#.*|)\n)*?  model: "([^"]*)"', "chart ai.model"),
    ("services/ai-service/app/config.py", r'OPENAI_MODEL: str = "([^"]*)"', "ai-service OPENAI_MODEL"),
    ("services/ai-service/app/services/provider_adapter.py", r'\n        model: str = "([^"]*)",', "ProviderAdapter model"),
    ("install-docker.sh", r"(?m)^OPENAI_MODEL=(?:\$\{MODEL:-([^}]*)\}|([^\s$]\S*))$", "install-docker.sh OPENAI_MODEL"),
    (".env.example", r"(?m)^OPENAI_MODEL=(\S*)$", ".env.example OPENAI_MODEL"),
    ("docker-compose.yml", r"OPENAI_MODEL=\$\{OPENAI_MODEL:-([^}]*)\}", "docker-compose.yml OPENAI_MODEL"),
    ("frontend/src/pages/setup/SetupAIModelPage.tsx",
     r"const \[aiModel, setAiModel\] = useState\((?:'([^']*)'|\(\) => getDefaultModel\('([\w-]+)'\))\)", "first-run setup page model", _setup_model),
    ("scripts/kind-model-haiku.sh", r'MODEL="\$\{HAIKU_MODEL:-([^}]*)\}"', "kind-model-haiku.sh model"),
    ("scripts/kind-model-subscription.sh", r'MODEL="\$\{SUBSCRIPTION_MODEL:-([^}]*)\}"', "kind-model-subscription.sh model"),
]

_CLAUDE = re.compile(r"claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?")
_CLAUDE_DATED = re.compile(r"claude-[a-z0-9-]+-\d{8}")
_OPENAI = re.compile(r"(?:gpt|chatgpt|o\d)[a-z0-9.-]*")
_OPENAI_DATED = re.compile(rf"(?:gpt|chatgpt|o\d)[a-z0-9.-]*-(?:20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?:-preview)?")
# OpenAI models whose own ID is their only snapshot: developers.openai.com/api/docs/models/<id> "Snapshots" (read 2026-11-15).
_OPENAI_OWN_SNAPSHOT = frozenset({"gpt-6-luna"})


def why_not_pinned(model: str) -> str | None:
    """None when model is a pinned snapshot ID, else why not."""
    if not model:
        return "empty"
    if "latest" in model:
        return "a name holding 'latest' points at whatever is newest"
    if model.startswith("claude-"):
        if _CLAUDE_DATED.fullmatch(model):
            return None
        m = _CLAUDE.fullmatch(model)
        if m and (int(m.group(1)), int(m.group(2) or 0)) >= (4, 6):
            return None
        return "a Claude alias before the 4.6 generation: write its dated ID"
    if _OPENAI.fullmatch(model):
        if _OPENAI_DATED.fullmatch(model) or model in _OPENAI_OWN_SNAPSHOT:
            return None
        return "an OpenAI alias: write the snapshot with its date (or, when OpenAI lists the ID as its own snapshot, add it to _OPENAI_OWN_SNAPSHOT)"
    return "no pin rule for this provider: add one from its documentation"


def read_default(entry: tuple, root: Path = ROOT) -> str | None:
    """The model a DEFAULTS entry names in the tree at root, or None when its place is not found."""
    rel, pattern = entry[0], entry[1]
    path = root / rel
    found = re.search(pattern, path.read_text(encoding="utf-8")) if path.exists() else None
    if found is None:
        return None
    if len(entry) > 3:
        return entry[3](found, root)
    return next((g for g in found.groups() if g is not None), None)


def check(root: Path = ROOT) -> list[str]:
    """One line per default that is not a pinned snapshot or was not found."""
    problems = []
    for entry in DEFAULTS:
        rel, what = entry[0], entry[2]
        model = read_default(entry, root)
        if model is None:
            problems.append(f"{rel}: {what} not found — the default moved; point scripts/check-model-pins.py at it")
            continue
        why = why_not_pinned(model)
        if why:
            problems.append(f"{rel}: {what} {model!r} is not pinned ({why})")
    return problems


def main() -> int:
    problems = check()
    for line in problems:
        print(line)
    if not problems:
        print(f"{len(DEFAULTS)} default models are pinned snapshots")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
