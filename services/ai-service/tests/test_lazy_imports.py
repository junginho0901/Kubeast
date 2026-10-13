"""The service does not load the provider SDK or the MCP SDK at start: openai
is imported when a model client is first made, the mcp SDK only when
MCP_ENABLED is on. Checked in a fresh interpreter, since other tests import
those modules in this process."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _modules_after(code: str, env: dict) -> set[str]:
    out = subprocess.run(
        [sys.executable, "-c", code + "\nimport sys; print('\\n'.join(sorted(m for m in sys.modules if m.split('.')[0] in {'openai', 'mcp'})))"],
        cwd=ROOT, env={**os.environ, **env}, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return {line for line in out.stdout.split("\n") if line}


def test_service_start_does_not_import_openai_or_mcp_when_mcp_is_off():
    loaded = _modules_after("import main", {"MCP_ENABLED": "false", "METRICS_ENABLED": "false"})
    assert not loaded, f"SDKs loaded at start: {sorted(loaded)[:5]}"


def test_mcp_on_loads_the_mcp_sdk_but_not_openai():
    loaded = _modules_after("import main", {"MCP_ENABLED": "true", "METRICS_ENABLED": "false"})
    assert any(m == "mcp" or m.startswith("mcp.") for m in loaded)
    assert not any(m == "openai" or m.startswith("openai.") for m in loaded)


def test_a_model_client_loads_openai():
    code = (
        "from app.services.provider_adapter import ProviderAdapter\n"
        "ProviderAdapter(provider='ollama', api_key='', base_url='http://127.0.0.1:1/v1')\n"
    )
    loaded = _modules_after(code, {"MCP_ENABLED": "false"})
    assert any(m == "openai" or m.startswith("openai.") for m in loaded)
