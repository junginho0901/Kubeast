"""The HTTP client for a model's address.

model_config_policy.check_base_url reads what a name resolves to when a config is saved and used, and a connection asks
the resolver again, when the name can answer differently. A client made here resolves once, holds those addresses to
check_connection and connects to exactly them. TLS is untouched: httpcore verifies and names the host of the URL, not the
address connected to.

An environment proxy keeps its own transport, not held to this rule: its address is the operator's, and the proxy resolves
the model's name. A host under NO_PROXY connects directly, so it goes through here.
"""
from __future__ import annotations

import ipaddress
import logging
import socket
import ssl
from typing import Any, Iterable, List, Optional, Union

import anyio
import httpcore
import httpx

from app.services import model_config_policy

logger = logging.getLogger(__name__)

# anyio.connect_tcp's delay before it starts on the next address.
NEXT_ADDRESS_DELAY = 0.25


async def _addresses(host: str, port: int) -> List[str]:
    """What anyio.connect_tcp would try, in its order: an IPv6 address first and an IPv4 one second when the answer holds both."""
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass
    v6_found = v4_found = False
    ordered: List[str] = []
    for family, *_, sockaddr in await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        if family == socket.AF_INET6 and not v6_found:
            v6_found = True
            ordered.insert(0, sockaddr[0])
        elif family == socket.AF_INET and not v4_found and v6_found:
            v4_found = True
            ordered.insert(1, sockaddr[0])
        else:
            ordered.append(sockaddr[0])
    return ordered


class _HeldToTheRule(httpcore.AsyncNetworkBackend):
    def __init__(self) -> None:
        self._network = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: Optional[float] = None,
        local_address: Optional[str] = None,
        socket_options: Optional[Iterable[Any]] = None,
    ) -> httpcore.AsyncNetworkStream:
        try:
            with anyio.fail_after(timeout):
                model_config_policy.check_connection_host(host)
                addresses = await _addresses(host, port)
                model_config_policy.check_connection(host, addresses)
                return await self._first_to_connect(addresses, port, local_address, socket_options)
        except model_config_policy.AddressRefused as refused:
            logger.warning("model connection refused: %s", refused.detail)
            raise
        except TimeoutError as e:
            raise httpcore.ConnectTimeout(e) from e
        except OSError as e:
            raise httpcore.ConnectError(e) from e

    async def _first_to_connect(self, addresses, port, local_address, socket_options) -> httpcore.AsyncNetworkStream:
        """Each address in turn, the next one starting when the last has failed or NEXT_ADDRESS_DELAY has passed."""
        if len(addresses) == 1:
            return await self._network.connect_tcp(addresses[0], port, local_address=local_address, socket_options=socket_options)
        connected: Optional[httpcore.AsyncNetworkStream] = None
        failures: List[httpcore.ConnectError] = []

        async def attempt(address: str, done: anyio.Event) -> None:
            nonlocal connected
            try:
                stream = await self._network.connect_tcp(address, port, local_address=local_address, socket_options=socket_options)
            except httpcore.ConnectError as e:
                failures.append(e)
            else:
                if connected is None:
                    connected = stream
                    group.cancel_scope.cancel()
                else:
                    await stream.aclose()
            finally:
                done.set()

        async with anyio.create_task_group() as group:
            for address in addresses:
                done = anyio.Event()
                group.start_soon(attempt, address, done)
                with anyio.move_on_after(NEXT_ADDRESS_DELAY):
                    await done.wait()
        if connected is None:
            raise httpcore.ConnectError("All connection attempts failed") from (failures[0] if failures else None)
        return connected

    async def sleep(self, seconds: float) -> None:
        await self._network.sleep(seconds)


def model_client(verify: Union[bool, ssl.SSLContext] = True, *, judged: bool = True, **kwargs: Any) -> httpx.AsyncClient:
    """An httpx.AsyncClient for a model. judged=False is for an address nobody typed into a config, a provider's built-in
    URL or the installer's OPENAI_BASE_URL, which check_base_url does not read either."""
    client = httpx.AsyncClient(verify=verify, **kwargs)
    # Passing transport= would turn the environment's proxies off, and httpx gives no other way to reach the pool's backend.
    transport = client._transport
    if judged and isinstance(transport, httpx.AsyncHTTPTransport):
        transport._pool._network_backend = _HeldToTheRule()
    return client
