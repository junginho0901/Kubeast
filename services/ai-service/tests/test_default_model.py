"""Every install path starts on the chart's ai.model: Docker Compose's fallback for an install without .env, the .env
install-docker.sh writes, .env.example, ai-service's own setting and adapter default, the configuration pages and the
screens' OpenAI default — the first of the catalog's OpenAI models (getDefaultModel), which the first-setup screen starts
on and every screen picks when OpenAI or its list is chosen. Compose fell back to gpt-4, which OpenAI has shut down, so a
Compose install without .env got no answers."""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


def _env_file_model(text: str) -> str:
    return re.search(r"^OPENAI_MODEL=(\S+)$", text, re.M).group(1)


def test_every_install_default_is_the_charts_model():
    chart = yaml.safe_load((ROOT / "helm/kubeast/values.yaml").read_text())["ai"]["model"]
    env = yaml.safe_load((ROOT / "docker-compose.yml").read_text())["services"]["ai-service"]["environment"]
    compose = next(e for e in env if e.startswith("OPENAI_MODEL="))
    config = (ROOT / "services/ai-service/app/config.py").read_text()
    adapter = (ROOT / "services/ai-service/app/services/provider_adapter.py").read_text()
    catalog = (ROOT / "frontend/src/constants/modelCatalog.ts").read_text()
    openai = re.search(r"id: 'openai',.*?models: \[(.*?)\]", catalog, re.S).group(1)
    found = {
        "docker-compose.yml": re.fullmatch(r"OPENAI_MODEL=\$\{OPENAI_MODEL:-([^}]+)\}", compose).group(1),
        # a rerun keeps the previous .env's model: the default is the fallback
        "install-docker.sh": re.search(r"^OPENAI_MODEL=\$\{MODEL:-([^}]+)\}$", (ROOT / "install-docker.sh").read_text(), re.M).group(1),
        ".env.example": _env_file_model((ROOT / ".env.example").read_text()),
        "app/config.py": re.search(r'^\s*OPENAI_MODEL: str = "([^"]+)"', config, re.M).group(1),
        "provider_adapter.py": re.search(r'^\s*model: str = "([^"]+)",$', adapter, re.M).group(1),
        "modelCatalog.ts first OpenAI model": re.search(r"name: '([^']+)'", openai).group(1),
    }
    for doc in ("docs/configuration.md", "docs/ko/configuration.md"):
        found[doc] = re.search(r'^  model: "([^"]+)"$', (ROOT / doc).read_text(), re.M).group(1)
    assert found == dict.fromkeys(found, chart)


def test_the_screens_pick_the_catalog_default():
    # a screen naming a model of its own, or taking a list's first entry, would start somewhere else
    setup = (ROOT / "frontend/src/pages/setup/SetupAIModelPage.tsx").read_text()
    assert "useState(() => getDefaultModel('openai'))" in setup
    for rel in ("frontend/src/pages/setup/SetupAIModelPage.tsx", "frontend/src/pages/admin-ai-models/useModelForm.ts",
                "frontend/src/pages/admin-ai-models/ModelConfigForm.tsx"):
        text = (ROOT / rel).read_text()
        assert not re.search(r"models\[0\]|Options\[0\]|fetchedModels\[0\]", text), rel
