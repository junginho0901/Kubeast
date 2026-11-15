"""Every install path starts on the chart's ai.model: Docker Compose's fallback for an install without .env, the .env
install-docker.sh writes, .env.example and ai-service's own setting. Compose fell back to gpt-4, which OpenAI has shut
down, so a Compose install without .env got no answers."""
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
    found = {
        "docker-compose.yml": re.fullmatch(r"OPENAI_MODEL=\$\{OPENAI_MODEL:-([^}]+)\}", compose).group(1),
        "install-docker.sh": _env_file_model((ROOT / "install-docker.sh").read_text()),
        ".env.example": _env_file_model((ROOT / ".env.example").read_text()),
        "app/config.py": re.search(r'^\s*OPENAI_MODEL: str = "([^"]+)"', config, re.M).group(1),
    }
    assert found == dict.fromkeys(found, chart)
