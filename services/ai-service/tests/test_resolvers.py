"""The AI tool dispatch resolves resource names through app.services.ai.resolvers.
These helpers were moved out of AIService in the May refactor but were still
called as service methods (NameError / AttributeError at runtime for every
k8s_get_resource_yaml / describe / logs call). Exercise them with a stub
service so the module keeps working end to end."""
import pytest

from app.services.ai import resolvers, tool_dispatch


class _K8s:
    """k8s-service's /pods/page: the search itself is the server's (tests/test_find_pods_cases.py)."""

    def __init__(self, pods):
        self._pods = pods
        self.asked = []

    async def get_pod_page(self, **params):
        self.asked.append(params)
        items = [p for p in self._pods if not params.get("namespace") or p.get("namespace") == params["namespace"]]
        items = [p for p in items if resolvers._all_tokens_in_text(None, params["q"], p["name"]) or resolvers._query_in_mapping(None, params["q"], p.get("labels"))]
        return {"items": items[: params["limit"]], "total": len(items)}


class _Service:
    user_role = "read"

    def __init__(self, pods):
        self.k8s_service = _K8s(pods)

    def _is_tool_allowed(self, name):
        return True


PODS = [
    {"name": "web-7d9f-abc12", "namespace": "app", "status": "Running", "ready": "1/1", "labels": {"app": "web"}},
    {"name": "web-7d9f-def34", "namespace": "app", "status": "Pending", "ready": "0/1", "labels": {"app": "web"}},
    {"name": "db-0", "namespace": "app", "status": "Running", "ready": "1/1", "labels": {"app": "db"}},
]


def test_tool_dispatch_imports_resolvers():
    assert tool_dispatch.resolvers is resolvers


@pytest.mark.asyncio
async def test_find_pods_asks_the_pod_rows():
    service = _Service(PODS)
    matches = await resolvers._find_pods(service, "web", namespace="app")
    assert service.k8s_service.asked == [{"q": "web", "match": "tokens", "sort": "find", "namespace": "app", "limit": 20}]
    assert [p["name"] for p in matches] == ["web-7d9f-abc12", "web-7d9f-def34"] and matches.total == 2
    by_label = await resolvers._find_pods(service, "app=db", limit=1)
    assert service.k8s_service.asked[-1]["namespace"] is None and [p["name"] for p in by_label] == ["db-0"]
    # nothing to search for: k8s-service is not asked
    assert await resolvers._find_pods(service, "   ") == [] and await resolvers._find_pods(service, "!!") == []
    assert len(service.k8s_service.asked) == 2


@pytest.mark.asyncio
async def test_resolve_single_says_how_many_matched():
    service = _Service(PODS)
    matches = await resolvers._find_pods(service, "web", limit=1)
    with pytest.raises(Exception, match=r"\(2 in all, the first 1 here\)"):
        await resolvers._resolve_single(service, "pods", "web", matches)


@pytest.mark.asyncio
async def test_resolve_single_and_limit():
    service = _Service(PODS)
    one = await resolvers._resolve_single(service, "pods", "db", [PODS[2]])
    assert one["name"] == "db-0"
    assert resolvers._coerce_limit(service, "5") == 5
    assert resolvers._coerce_limit(service, "not-a-number", default=7) == 7
    assert resolvers._coerce_limit(service, 10_000, max_value=200) == 200


@pytest.mark.asyncio
async def test_legacy_execute_function_find_pods():
    # The no-context dispatch path (oneshot / streaming without ToolContext)
    # referenced `self` inside a module-level function.
    import json

    service = _Service(PODS)
    out = await tool_dispatch._execute_function(service, "find_pods", {"query": "web", "namespace": "app", "limit": "1"})
    assert [p["name"] for p in json.loads(out)] == ["web-7d9f-abc12"]
