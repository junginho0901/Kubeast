"""One httpx.AsyncClient per upstream, request-scoped headers on top.

Every chat request used to build its own AsyncClient for k8s-service and
tool-server (carrying that user's JWT) and never closed it. httpx keeps one
connection pool per client, so that both leaked sockets and defeated pooling.
Here the pool is shared per base URL and each request gets a thin scope that
only adds its own headers and query params to every call.
"""
from typing import Any, Dict, Optional, Tuple

import httpx

_pools: Dict[Tuple[str, float], httpx.AsyncClient] = {}


def shared_client(base_url: str, timeout: float) -> httpx.AsyncClient:
    key = (base_url.rstrip("/"), timeout)
    client = _pools.get(key)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(base_url=key[0], timeout=timeout)
        _pools[key] = client
    return client


async def close_shared_clients() -> None:
    for client in list(_pools.values()):
        await client.aclose()
    _pools.clear()


class ScopedClient:
    """The subset of httpx.AsyncClient the service clients call, bound to one
    request's headers and params. `params`/`headers` stay readable as dicts."""

    def __init__(self, base_url: str, timeout: float, headers: Optional[Dict[str, str]] = None,
                 params: Optional[Dict[str, str]] = None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers: Dict[str, str] = dict(headers or {})
        self.params: Dict[str, str] = dict(params or {})

    @property
    def pool(self) -> httpx.AsyncClient:
        return shared_client(self.base_url, self.timeout)

    def _merge(self, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", None) or {})
        params = dict(self.params)
        params.update(kwargs.pop("params", None) or {})
        if headers:
            kwargs["headers"] = headers
        if params:
            kwargs["params"] = params
        return kwargs

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        return await self.pool.request(method, url, **self._merge(kwargs))

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PUT", url, **kwargs)

    async def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PATCH", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)
