"""Every install path starts on the chart's ai.model: Docker Compose's fallback for an install without .env, the .env
install-docker.sh writes, .env.example, ai-service's own setting and adapter default, the first-setup screen and the
configuration pages. Compose fell back to gpt-4, which OpenAI has shut down, so a Compose install without .env got no
answers."""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


def _env_file_model(text: str) -> str:
    return re.search(r"^OPENAI_MODEL=(\S+)$", text, re.M).group(1)


def _chart_model() -> str:
    return yaml.safe_load((ROOT / "helm/kubeast/values.yaml").read_text())["ai"]["model"]


def test_every_install_default_is_the_charts_model():
    chart = _chart_model()
    env = yaml.safe_load((ROOT / "docker-compose.yml").read_text())["services"]["ai-service"]["environment"]
    compose = next(e for e in env if e.startswith("OPENAI_MODEL="))
    config = (ROOT / "services/ai-service/app/config.py").read_text()
    adapter = (ROOT / "services/ai-service/app/services/provider_adapter.py").read_text()
    setup = (ROOT / "frontend/src/pages/setup/SetupAIModelPage.tsx").read_text()
    found = {
        "docker-compose.yml": re.fullmatch(r"OPENAI_MODEL=\$\{OPENAI_MODEL:-([^}]+)\}", compose).group(1),
        "install-docker.sh": _env_file_model((ROOT / "install-docker.sh").read_text()),
        ".env.example": _env_file_model((ROOT / ".env.example").read_text()),
        "app/config.py": re.search(r'^\s*OPENAI_MODEL: str = "([^"]+)"', config, re.M).group(1),
        "provider_adapter.py": re.search(r'^\s*model: str = "([^"]+)",$', adapter, re.M).group(1),
        "SetupAIModelPage.tsx": re.search(r"\[aiModel, setAiModel\] = useState\('([^']+)'\)", setup).group(1),
    }
    for doc in ("docs/configuration.md", "docs/ko/configuration.md"):
        found[doc] = re.search(r'^  model: "([^"]+)"$', (ROOT / doc).read_text(), re.M).group(1)
    assert found == dict.fromkeys(found, chart)


def test_setup_screen_lists_the_default_model():
    # the first-setup dropdown starts on the chart's model; a name missing from the OpenAI list shows "Select model"
    catalog = (ROOT / "frontend/src/constants/modelCatalog.ts").read_text()
    openai = re.search(r"id: 'openai',.*?models: \[(.*?)\]", catalog, re.S).group(1)
    assert _chart_model() in re.findall(r"name: '([^']+)'", openai)
