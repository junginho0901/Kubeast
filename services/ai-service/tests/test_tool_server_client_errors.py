"""call_tool keeps tool-server's reason ({"error": ...}) on an error status,
so a refused write (the Argo CD guard, a cluster 403) reaches the user."""
import httpx
import pytest

from app.services.tool_server_client import ToolServerClient


def _client(handler) -> ToolServerClient:
    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(handler))
    return c


@pytest.mark.asyncio
async def test_error_body_becomes_the_message():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": "conflict: Deployment default/web is managed by Argo CD application app; change it in Git"})

    with pytest.raises(Exception) as exc:
        await _client(handler).call_tool("k8s_scale", {"resource_type": "deployment", "resource_name": "web"})
    assert str(exc.value) == "conflict: Deployment default/web is managed by Argo CD application app; change it in Git"


@pytest.mark.asyncio
async def test_error_without_body_keeps_the_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="bad gateway")

    with pytest.raises(httpx.HTTPStatusError):
        await _client(handler).call_tool("k8s_get_resources", {})


@pytest.mark.asyncio
async def test_success_returns_content():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": "ok", "redacted": {"count": 0}})

    c = _client(handler)
    assert await c.call_tool("k8s_get_resources", {}) == "ok"
    assert c.last_redacted == {"count": 0}
