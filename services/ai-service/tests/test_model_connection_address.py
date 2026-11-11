"""A model's address is judged when a connection opens, by the rule the address is judged by when it is saved and used,
on every way ai-service reaches a model. Real sockets on loopback: the resolver is a stand-in, and anything that would
leave the machine stops at socket.connect and is written down, so the tests send nothing out.

The second half holds what must stay as it was: keep-alive, timeouts, retries, both address families, long streams,
private CAs, proxies, and the addresses nobody typed in."""
import asyncio
import datetime
import errno
import ipaddress
import json
import pathlib
import socket
import ssl
import time
from types import SimpleNamespace

import httpx
import openai
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app import api_public
from app.services import model_config_policy as policy
from app.services import tls
from app.services.ai import model_errors, streaming
from app.services.provider_adapter import ProviderAdapter

FAKE_KEY = "fake-model-key-for-a-test"
NAME = "model.example.test"
PUBLIC = "93.184.216.34"
PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946"
METADATA = "169.254.169.254"
PRIVATE = "10.1.2.3"
LIST_VARIABLE = "AI_BASE_URL_ALLOWED_HOSTS"
MESSAGES = [{"role": "user", "content": "hi"}]
ADDRESS_CASES = json.loads((pathlib.Path(__file__).parent / "fixtures" / "address_forms_cases.json").read_text())
PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")

REAL_GETADDRINFO = socket.getaddrinfo
REAL_CONNECT = socket.socket.connect


def _is_address(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


class Names:
    """The resolver: a name's answers are used in turn and the last one stays. A name it does not hold does not resolve."""

    def __init__(self):
        self.table = {}
        self.asked = []
        self.delay = 0.0

    def answer(self, name, *answers):
        self.table[name] = [list(a) if isinstance(a, (list, tuple)) else [a] for a in answers]

    def __call__(self, host, port, family=0, type=0, proto=0, flags=0):
        name = host.decode() if isinstance(host, bytes) else host
        if name == "localhost" or _is_address(name):
            return REAL_GETADDRINFO(host, port, family, type, proto, flags)
        self.asked.append(name)
        if self.delay:
            time.sleep(self.delay)
        if name not in self.table:
            raise socket.gaierror(socket.EAI_NONAME, "the stand-in does not hold this name")
        answers = self.table[name]
        current = answers.pop(0) if len(answers) > 1 else answers[0]
        out = []
        for ip in current:
            if ":" in ip:
                out.append((socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port or 0, 0, 0)))
            else:
                out.append((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port or 0)))
        return out


class Wire:
    """socket.connect: loopback goes through to the test's servers, anything else is written down and stops here."""

    def __init__(self):
        self.dialled = []

    def install(self, monkeypatch):
        wire = self

        def connect(sock, address):
            if not isinstance(address, tuple):
                return REAL_CONNECT(sock, address)
            wire.dialled.append(address[0])
            if address[0] in ("127.0.0.1", "::1"):
                return REAL_CONNECT(sock, address)
            raise ConnectionRefusedError(errno.ECONNREFUSED, "stopped by the test before leaving the machine")

        monkeypatch.setattr(socket.socket, "connect", connect, raising=False)


class ModelServer:
    """A model endpoint on a real socket: the chat completions, Messages and models routes, with keep-alive and streams."""

    def __init__(self, ssl_context=None):
        self.ssl_context = ssl_context
        self.connections = 0
        self.requests = []
        self.keep_alive = True
        self.chunks = 3
        self.gap = 0.0
        self.silent = False
        self.redirect_to = None
        self.refuse_tunnel = False
        self._server = None
        self._writers = []
        self._tasks = set()
        self.port = 0

    async def start(self, host="127.0.0.1", port=0):
        self._server = await asyncio.start_server(self._serve, host, port, ssl=self.ssl_context)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        self._server.close()
        for w in self._writers:
            w.close()
        for t in list(self._tasks):
            t.cancel()

    def saw_the_key(self) -> bool:
        return any(FAKE_KEY in r["head"] for r in self.requests)

    async def _serve(self, reader, writer):
        self.connections += 1
        self._writers.append(writer)
        task = asyncio.current_task()
        self._tasks.add(task)
        try:
            while True:
                try:
                    head = (await reader.readuntil(b"\r\n\r\n")).decode()
                except (asyncio.IncompleteReadError, ConnectionError):
                    return
                lines = head.split("\r\n")
                headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
                body = await reader.readexactly(int(headers.get("content-length") or 0))
                self.requests.append({"line": lines[0], "head": head, "body": body})
                await self._answer(lines[0], body, writer)
                if not self.keep_alive:
                    return
        finally:
            self._tasks.discard(task)
            writer.close()

    async def _answer(self, line, body, writer):
        method, target = line.split()[:2]
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
            await writer.drain()
            return
        if self.silent:
            await asyncio.sleep(3600)
        if self.redirect_to:
            writer.write(f"HTTP/1.1 302 Found\r\nlocation: {self.redirect_to}\r\ncontent-length: 0\r\n\r\n".encode())
            await writer.drain()
            return
        streamed = bool(body) and json.loads(body).get("stream")
        if streamed:
            await self._stream(target, writer)
            return
        if target.endswith("/messages"):
            answer = {"id": "m1", "type": "message", "role": "assistant", "model": "m", "content": [{"type": "text", "text": "pong"}],
                      "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}
        elif target.endswith("/models") or "/models?" in target:
            answer = {"data": [{"id": "listed-model", "display_name": "Listed"}]}
        else:
            answer = {"id": "c1", "object": "chat.completion", "created": 0, "model": "m",
                      "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}]}
        data = json.dumps(answer).encode()
        close = b"" if self.keep_alive else b"connection: close\r\n"
        writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n" + close + f"content-length: {len(data)}\r\n\r\n".encode() + data)
        await writer.drain()

    async def _stream(self, target, writer):
        close = b"" if self.keep_alive else b"connection: close\r\n"
        writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n" + close + b"transfer-encoding: chunked\r\n\r\n")

        async def send(event):
            data = f"data: {event}\n\n".encode()
            writer.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            await writer.drain()
            if self.gap:
                await asyncio.sleep(self.gap)

        if target.endswith("/messages"):
            await send(json.dumps({"type": "message_start", "message": {"id": "m1", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 0}}}))
            await send(json.dumps({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
            for i in range(self.chunks):
                await send(json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": f"w{i} "}}))
            await send(json.dumps({"type": "content_block_stop", "index": 0}))
            await send(json.dumps({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}))
            await send(json.dumps({"type": "message_stop"}))
        else:
            for i in range(self.chunks):
                await send(json.dumps({"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "m",
                                       "choices": [{"index": 0, "delta": {"content": f"w{i} "}, "finish_reason": None}]}))
            await send("[DONE]")
        writer.write(b"0\r\n\r\n")
        await writer.drain()


@pytest.fixture
def names(monkeypatch):
    stand_in = Names()
    monkeypatch.setattr(socket, "getaddrinfo", stand_in)
    # check_base_url bound the real resolver as its default when it was defined
    monkeypatch.setattr(policy.check_base_url, "__defaults__", (stand_in,))
    return stand_in


@pytest.fixture
def wire(monkeypatch):
    w = Wire()
    w.install(monkeypatch)
    return w


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    monkeypatch.delenv(LIST_VARIABLE, raising=False)
    for name in PROXY_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("CUSTOM_CA_DIR", raising=False)
    tls._custom_ca_files.cache_clear()
    yield
    tls._custom_ca_files.cache_clear()


@pytest.fixture
async def server():
    s = await ModelServer().start()
    yield s
    await s.stop()


def adapter_for(provider, base, **kw):
    return ProviderAdapter(provider=provider, model="m", api_key=FAKE_KEY, base_url=base, **kw)


# Each way ai-service reaches a model with an address someone typed in: the screens' routes and the chat's client.
async def _chat(provider, base, stream=False):
    # What the use-time check (model_config_service) has just passed.
    policy.check_base_url(base)
    client = adapter_for(provider, base)
    if not stream:
        return await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    return [c async for c in await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5, stream=True)]


def _route(call, body):
    return lambda port: call({**body, "base_url": body["base_url"].format(host=NAME, port=port)})


def _chat_path(provider, base="http://{host}:{port}/v1", stream=False):
    return lambda port: _chat(provider, base.format(host=NAME, port=port), stream=stream)


TEST_ROUTE = api_public._test_model_connection
LIST_ROUTE = api_public._list_provider_models
EVERY_PATH = {
    "chat openai": _chat_path("openai"),
    "chat openai-compatible": _chat_path("custom"),
    "chat gemini": _chat_path("gemini"),
    "chat ollama": _chat_path("ollama"),
    "chat azure": _chat_path("azure", "http://{host}:{port}/openai/v1/"),
    "chat azureopenai": _chat_path("azureopenai", "http://{host}:{port}/openai/v1/"),
    "chat anthropic": _chat_path("anthropic", "http://{host}:{port}"),
    "stream openai-compatible": _chat_path("custom", stream=True),
    "stream anthropic": _chat_path("anthropic", "http://{host}:{port}", stream=True),
    "connection test openai-compatible": _route(TEST_ROUTE, {"provider": "custom", "model": "m", "api_key": FAKE_KEY, "base_url": "http://{host}:{port}/v1"}),
    "connection test anthropic": _route(TEST_ROUTE, {"provider": "anthropic", "model": "m", "api_key": FAKE_KEY, "base_url": "http://{host}:{port}"}),
    "connection test azure": _route(TEST_ROUTE, {"provider": "azure", "model": "m", "api_key": FAKE_KEY, "base_url": "http://{host}:{port}/openai/v1/"}),
    "connection test ollama": _route(TEST_ROUTE, {"provider": "ollama", "model": "m", "base_url": "http://{host}:{port}"}),
    "model list openai-compatible": _route(LIST_ROUTE, {"provider": "custom", "api_key_env": "OPENAI_API_KEY", "base_url": "http://{host}:{port}/v1"}),
    "model list anthropic": _route(LIST_ROUTE, {"provider": "anthropic", "api_key_env": "ANTHROPIC_API_KEY", "base_url": "http://{host}:{port}"}),
    "model list gemini": _route(LIST_ROUTE, {"provider": "gemini", "api_key_env": "GEMINI_API_KEY", "base_url": "http://{host}:{port}/v1"}),
    "model list ollama": _route(LIST_ROUTE, {"provider": "ollama", "base_url": "http://{host}:{port}"}),
}


@pytest.fixture
def keys(monkeypatch):
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.setenv(name, FAKE_KEY)


async def _investigation_client(monkeypatch, base):
    """The client an alert investigation runs on, from the config runner.build_service resolves."""
    from app.services import model_config_service
    from app.services.investigation import runner

    resolved = model_config_service.ResolvedModelConfig(
        provider="custom", model="m", base_url=base, api_key=FAKE_KEY, extra_headers={}, tls_verify=True)

    async def resolve(config_id=None):
        return resolved

    monkeypatch.setattr(model_config_service, "resolve_model_config", resolve)
    return await runner.build_service(SimpleNamespace(model=""), "a-token", "c1")


# ---- the address a connection is about to use ----

@pytest.mark.parametrize("path", EVERY_PATH, ids=str)
async def test_a_name_answering_differently_when_connecting_does_not_get_the_request(names, wire, server, keys, path):
    names.answer(NAME, PUBLIC, "127.0.0.1")
    try:
        await EVERY_PATH[path](server.port)
    except Exception:
        pass
    assert server.connections == 0, f"the server was reached: {server.requests}"
    assert not server.saw_the_key()
    assert wire.dialled == []


@pytest.mark.parametrize("path", EVERY_PATH, ids=str)
async def test_a_metadata_address_when_connecting_is_never_dialled(names, wire, server, keys, path):
    names.answer(NAME, PUBLIC, METADATA)
    try:
        await EVERY_PATH[path](server.port)
    except Exception:
        pass
    assert wire.dialled == []


async def test_an_investigation_connects_by_the_same_rule(names, wire, server, monkeypatch):
    names.answer(NAME, PUBLIC, "127.0.0.1")
    service = await _investigation_client(monkeypatch, f"http://{NAME}:{server.port}/v1")
    policy.check_base_url(f"http://{NAME}:{server.port}/v1")
    with pytest.raises(Exception):
        await service.client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert server.connections == 0 and wire.dialled == []


@pytest.mark.parametrize("case", ADDRESS_CASES, ids=lambda c: c["address"])
async def test_the_rule_when_connecting_reads_every_form_as_the_rule_when_saving(names, wire, monkeypatch, case):
    """address_forms_cases.json through the model list's client, as the host and as what a name resolves to."""
    address = case["address"]
    literal = f"http://[{address}]:8080/v1" if ":" in address else f"http://{address}:8080/v1"
    named = f"http://{NAME}:8080/v1"
    names.answer(NAME, address)

    async def dialled(url):
        wire.dialled.clear()
        try:
            await api_public._list_models("custom", FAKE_KEY, url, True)
        except Exception:
            pass
        return [ipaddress.ip_address(d) for d in wire.dialled]

    reached = [ipaddress.ip_address(address)]
    if case["model"] == "never":
        assert await dialled(literal) == []
        assert await dialled(named) == []
        monkeypatch.setenv(LIST_VARIABLE, f"{address},{NAME}")
        assert await dialled(literal) == []
        assert await dialled(named) == []
    elif case["model"] == "listed":
        assert await dialled(literal) == []
        assert await dialled(named) == []
        monkeypatch.setenv(LIST_VARIABLE, f"{address},{NAME}")
        assert await dialled(literal) == reached
        assert await dialled(named) == reached
    else:
        assert case["model"] == "open"
        assert await dialled(literal) == reached
        assert await dialled(named) == reached


async def test_one_refused_address_among_the_answers_refuses_the_connection(names, wire):
    """"Every address the host resolves to must be public": at save time and when connecting."""
    names.answer(NAME, [PUBLIC, PRIVATE])
    with pytest.raises(Exception):
        await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:8080/v1", True)
    assert wire.dialled == []


async def test_a_metadata_name_is_refused_by_its_name_when_connecting(names, wire):
    names.answer("metadata.google.internal", PUBLIC)
    with pytest.raises(Exception):
        await api_public._list_models("custom", FAKE_KEY, "http://metadata.google.internal/v1", True)
    assert wire.dialled == [] and names.asked == []


@pytest.mark.parametrize("listed", [NAME, ".example.test", f" {NAME.upper()} "])
async def test_a_listed_host_may_use_a_private_address(names, wire, server, monkeypatch, listed):
    monkeypatch.setenv(LIST_VARIABLE, listed)
    names.answer(NAME, "127.0.0.1")
    out = await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:{server.port}/v1", True)
    assert out == [{"name": "listed-model"}] and server.saw_the_key()


async def test_a_listed_host_is_still_refused_a_metadata_address_it_resolves_to(names, wire, monkeypatch):
    """check_base_url does not resolve a listed host, so this is the only place that can tell."""
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, METADATA)
    policy.check_base_url(f"http://{NAME}:8080/v1")
    with pytest.raises(Exception):
        await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:8080/v1", True)
    assert wire.dialled == []


@pytest.mark.parametrize("written,listed", [
    ("bücher.example.test", "bücher.example.test"),
    ("xn--bcher-kva.example.test", "xn--bcher-kva.example.test"),
    ("bücher.example.test", ".example.test"),
])
async def test_an_international_name_on_the_list_stays_on_the_list_when_connecting(names, wire, server, monkeypatch, written, listed):
    monkeypatch.setenv(LIST_VARIABLE, listed)
    names.answer("xn--bcher-kva.example.test", "127.0.0.1")
    out = await api_public._list_models("custom", FAKE_KEY, f"http://{written}:{server.port}/v1", True)
    assert out == [{"name": "listed-model"}]


async def test_an_international_name_not_on_the_list_is_judged(names, wire, server):
    names.answer("xn--bcher-kva.example.test", "127.0.0.1")
    with pytest.raises(Exception):
        await api_public._list_models("custom", FAKE_KEY, f"http://bücher.example.test:{server.port}/v1", True)
    assert server.connections == 0


async def test_a_redirect_to_another_host_is_judged_as_its_own_connection(names, wire, server, monkeypatch):
    """No code path follows a redirect today; a client that does gets the same answer for the next host."""
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    names.answer("other.example.test", "127.0.0.1")
    server.redirect_to = f"http://other.example.test:{server.port}/v1/models"
    client = adapter_for("custom", f"http://{NAME}:{server.port}/v1")._openai_client._client
    with pytest.raises(Exception):
        await client.get(f"http://{NAME}:{server.port}/v1/models", follow_redirects=True)
    assert len(server.requests) == 1, server.requests


async def test_a_new_connection_after_a_closed_one_is_judged_again(names, wire, server, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1", METADATA)
    server.keep_alive = False
    client = adapter_for("custom", f"http://{NAME}:{server.port}/v1")
    first = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert first.choices[0].message.content == "pong"
    wire.dialled.clear()
    with pytest.raises(Exception):
        await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert wire.dialled == []


# ---- what each reader is told ----

async def _refusal(names, port, second):
    names.answer(NAME, PUBLIC, second)
    base = f"http://{NAME}:{port}/v1"
    policy.check_base_url(base)
    with pytest.raises(Exception) as caught:
        await adapter_for("custom", base).chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    return caught.value


async def test_the_chat_says_the_address_was_refused_without_naming_it(names, wire, server):
    err = await _refusal(names, server.port, PRIVATE)
    event = streaming.model_error(SimpleNamespace(provider="custom"), err)
    assert event["error_key"] == "modelAddress"
    assert event["error_args"]["provider"] == "OpenAI-compatible"
    assert "Admin → AI Models" in event["error"]
    text = json.dumps(event)
    assert PRIVATE not in text and LIST_VARIABLE not in text


async def test_the_chat_says_the_same_on_the_anthropic_client(names, wire):
    names.answer(NAME, PUBLIC, PRIVATE)
    base = f"http://{NAME}:8080"
    policy.check_base_url(base)
    with pytest.raises(Exception) as caught:
        await adapter_for("anthropic", base).chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    event = streaming.model_error(SimpleNamespace(provider="anthropic"), caught.value)
    assert event["error_key"] == "modelAddress" and PRIVATE not in json.dumps(event)
    assert wire.dialled == []


async def test_a_stored_address_refused_on_use_tells_the_chat_why_without_naming_it(names, wire, monkeypatch):
    """A name that stays on the other address is seen by the use-time check: the chat request is refused, not a bare 500."""
    from fastapi import HTTPException

    from app import api
    from app.services import model_config_service as mcs

    row = SimpleNamespace(id=1, provider="custom", model="m", base_url=f"http://{NAME}:8080/v1", api_key_env=None, api_key_secret_key=None,
                          extra_headers={}, tls_verify=True, ca_cert=None, options=None)

    async def active():
        return row

    async def database():
        return SimpleNamespace(get_active_model_config=active)

    monkeypatch.setattr(mcs, "get_db_service", database)
    names.answer(NAME, PRIVATE)
    mcs.invalidate_model_config_cache()
    try:
        with pytest.raises(HTTPException) as caught:
            await api._build_ai_service("Bearer a-token", cluster_name="self")
    finally:
        mcs.invalidate_model_config_cache()
    assert caught.value.status_code == 503
    assert "not allowed" in caught.value.detail and "Admin → AI Models" in caught.value.detail
    assert PRIVATE not in caught.value.detail and LIST_VARIABLE not in caught.value.detail
    assert wire.dialled == []


async def test_a_refused_address_is_not_read_as_an_outage_and_does_not_pause_investigations(names, wire, server):
    from app.services.investigation.runner import clean_error

    err = await _refusal(names, server.port, PRIVATE)
    refusal = model_errors.classify(err)
    assert refusal.kind != model_errors.UNAVAILABLE
    assert refusal.blocks is False
    assert PRIVATE not in clean_error(err)


async def test_a_wrapped_refusal_is_still_read_as_one(names, wire, server):
    """Older SDKs wrap whatever their client raises in APIConnectionError."""
    err = await _refusal(names, server.port, PRIVATE)
    request = httpx.Request("POST", "http://x/")
    try:
        raise openai.APIConnectionError(request=request) from err
    except openai.APIConnectionError as wrapped:
        event = streaming.model_error(SimpleNamespace(provider="custom"), wrapped)
    assert event["error_key"] == "modelAddress"


@pytest.mark.parametrize("provider,base", [
    ("custom", "http://{host}:{port}/v1"), ("anthropic", "http://{host}:{port}"), ("azure", "http://{host}:{port}/openai/v1/"), ("ollama", "http://{host}:{port}"),
])
async def test_the_connection_test_tells_who_manages_models_which_address_and_what_to_do(names, wire, server, provider, base):
    names.answer(NAME, PUBLIC, PRIVATE)
    out = await TEST_ROUTE({"provider": provider, "model": "m", "api_key": FAKE_KEY, "base_url": base.format(host=NAME, port=server.port)})
    assert out["success"] is False
    assert PRIVATE in out["message"] and LIST_VARIABLE in out["message"]


async def test_the_connection_test_does_not_offer_the_list_for_a_metadata_address(names, wire, server):
    names.answer(NAME, PUBLIC, METADATA)
    out = await TEST_ROUTE({"provider": "custom", "model": "m", "api_key": FAKE_KEY, "base_url": f"http://{NAME}:{server.port}/v1"})
    assert out["success"] is False
    assert "not allowed" in out["message"] and METADATA in out["message"] and LIST_VARIABLE not in out["message"]


async def test_the_model_list_says_why_it_has_nothing(names, wire, server, keys):
    names.answer(NAME, PUBLIC, PRIVATE)
    out = await LIST_ROUTE({"provider": "custom", "api_key_env": "OPENAI_API_KEY", "base_url": f"http://{NAME}:{server.port}/v1"})
    assert out["models"] == []
    assert PRIVATE in out["error"] and LIST_VARIABLE in out["error"]


async def test_the_connection_test_row_holds_the_refusal(names, wire, server, monkeypatch):
    from app.services import model_config_audit

    rows = []

    async def ready(_what):
        return None

    async def record(action, payload, raw, name, **kw):
        rows.append((action, kw))

    monkeypatch.setattr(model_config_audit, "ready_or_503", ready)
    monkeypatch.setattr(model_config_audit, "record", record)
    names.answer(NAME, PUBLIC, PRIVATE)
    body = {"provider": "custom", "model": "m", "api_key": FAKE_KEY, "base_url": f"http://{NAME}:{server.port}/v1"}
    await api_public.test_model_connection(None, payload=SimpleNamespace(), request=body)
    action, kw = rows[0]
    assert action == "ai.model_config.test" and kw["result"] == "failure" and kw["extra"]["ok"] is False
    assert PRIVATE in kw["error"]


# ---- what stays as it was ----

async def test_a_kept_connection_serves_several_requests_and_the_name_is_asked_once(names, wire, server, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    client = adapter_for("custom", f"http://{NAME}:{server.port}/v1")
    for _ in range(3):
        resp = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
        assert resp.choices[0].message.content == "pong"
    assert server.connections == 1 and len(server.requests) == 3
    assert names.asked == [NAME] and wire.dialled == ["127.0.0.1"]


@pytest.mark.parametrize("provider,base", [("custom", "http://{host}:{port}/v1"), ("anthropic", "http://{host}:{port}")])
async def test_a_long_stream_comes_whole_and_in_order(names, wire, server, monkeypatch, provider, base):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server.chunks = 1000
    client = adapter_for(provider, base.format(host=NAME, port=server.port))
    stream = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5, stream=True)
    words = [c.choices[0].delta.content async for c in stream if c.choices and c.choices[0].delta.content]
    assert words == [f"w{i} " for i in range(1000)]


@pytest.mark.parametrize("provider,base,timeout", [
    ("custom", "http://{host}:{port}/v1", httpx.Timeout(5.0, connect=0.5)),
    # The Anthropic client takes one number and hands it to httpx.Timeout: it bounds each read, not the whole stream.
    ("anthropic", "http://{host}:{port}", 0.5),
])
async def test_a_stream_lives_past_its_timeouts_while_chunks_keep_coming(names, wire, server, monkeypatch, provider, base, timeout):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server.gap = 0.05
    server.chunks = 20
    client = adapter_for(provider, base.format(host=NAME, port=server.port))
    stream = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5, stream=True, timeout=timeout)
    words = [c.choices[0].delta.content async for c in stream if c.choices and c.choices[0].delta.content]
    assert words == [f"w{i} " for i in range(20)]


async def test_a_refused_port_is_retried_as_the_sdk_retries(names, wire, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        free_port = held.getsockname()[1]
    client = adapter_for("custom", f"http://{NAME}:{free_port}/v1")
    with pytest.raises(openai.APIConnectionError) as caught:
        await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert wire.dialled == ["127.0.0.1"] * 3
    assert isinstance(caught.value.__cause__, httpx.ConnectError)
    assert str(caught.value.__cause__) == "All connection attempts failed"


async def test_the_anthropic_client_retries_a_refused_port(names, wire, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        free_port = held.getsockname()[1]
    client = adapter_for("anthropic", f"http://{NAME}:{free_port}")
    with pytest.raises(Exception, match="connection_error"):
        await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert wire.dialled == ["127.0.0.1"] * 3


async def test_a_name_that_does_not_resolve_stays_a_connect_error(names, wire):
    with pytest.raises(httpx.ConnectError):
        await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:8080/v1", True)
    assert wire.dialled == []


async def test_a_slow_resolver_counts_in_the_connect_timeout(names, wire, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    names.delay = 0.6
    client = adapter_for("custom", f"http://{NAME}:8080/v1")._openai_client._client
    started = time.monotonic()
    with pytest.raises(httpx.ConnectTimeout):
        await client.get(f"http://{NAME}:8080/v1/models", timeout=httpx.Timeout(5.0, connect=0.1))
    assert time.monotonic() - started < 0.5


def _hang(monkeypatch, hanging):
    """An address that takes the packets and never answers."""
    from anyio._backends._asyncio import AsyncIOBackend
    import anyio

    real = AsyncIOBackend.connect_tcp

    async def connect(cls, host, port, local_address=None):
        if host in hanging:
            await anyio.sleep_forever()
        return await real(host, port, local_address)

    monkeypatch.setattr(AsyncIOBackend, "connect_tcp", classmethod(connect))


async def test_an_address_that_never_answers_ends_at_the_connect_timeout(names, wire, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    _hang(monkeypatch, {"127.0.0.1"})
    client = adapter_for("custom", f"http://{NAME}:8080/v1")._openai_client._client
    started = time.monotonic()
    with pytest.raises(httpx.ConnectTimeout):
        await client.get(f"http://{NAME}:8080/v1/models", timeout=httpx.Timeout(5.0, connect=0.1))
    assert time.monotonic() - started < 0.5


async def test_a_model_that_does_not_answer_ends_at_the_read_timeout(names, wire, server, monkeypatch):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server.silent = True
    client = adapter_for("custom", f"http://{NAME}:{server.port}/v1")._openai_client._client
    with pytest.raises(httpx.ReadTimeout):
        await client.get(f"http://{NAME}:{server.port}/v1/models", timeout=httpx.Timeout(5.0, read=0.1))


def _needs_ipv6():
    try:
        with socket.socket(socket.AF_INET6) as s:
            s.bind(("::1", 0))
    except OSError:
        pytest.skip("no IPv6 loopback here")


async def test_ipv6_is_tried_first_and_ipv4_takes_over_when_it_is_refused(names, wire, server, monkeypatch):
    _needs_ipv6()
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, ["127.0.0.1", "::1"])
    out = await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:{server.port}/v1", True)
    assert out == [{"name": "listed-model"}]
    assert wire.dialled == ["::1", "127.0.0.1"]


async def test_an_ipv6_only_server_is_reached(names, wire, monkeypatch):
    _needs_ipv6()
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, ["127.0.0.1", "::1"])
    only_v6 = await ModelServer().start("::1")
    try:
        out = await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:{only_v6.port}/v1", True)
    finally:
        await only_v6.stop()
    assert out == [{"name": "listed-model"}] and only_v6.connections == 1


async def test_an_ipv6_address_literal_reaches_the_server(names, wire, monkeypatch):
    _needs_ipv6()
    monkeypatch.setenv(LIST_VARIABLE, "::1")
    only_v6 = await ModelServer().start("::1")
    try:
        out = await api_public._list_models("custom", FAKE_KEY, f"http://[::1]:{only_v6.port}/v1", True)
    finally:
        await only_v6.stop()
    assert out == [{"name": "listed-model"}] and names.asked == []


async def test_when_ipv6_never_answers_ipv4_starts_after_the_short_delay(names, wire, server, monkeypatch):
    _needs_ipv6()
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, ["::1", "127.0.0.1"])
    _hang(monkeypatch, {"::1"})
    started = time.monotonic()
    out = await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:{server.port}/v1", True)
    elapsed = time.monotonic() - started
    assert out == [{"name": "listed-model"}]
    assert 0.2 < elapsed < 2.0, elapsed


async def test_both_families_of_a_public_name_are_tried(names, wire):
    names.answer(NAME, [PUBLIC, PUBLIC_V6])
    with pytest.raises(httpx.ConnectError, match="All connection attempts failed"):
        await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:8080/v1", True)
    assert wire.dialled == [PUBLIC_V6, PUBLIC]


# TLS: the certificate and SNI are the name's, whatever address the connection went to.

def _certificate(name, issuer=None):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    builder = (
        x509.CertificateBuilder().subject_name(subject)
        .issuer_name(issuer[0].subject if issuer else subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=issuer is None, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    if issuer is None:
        builder = builder.add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
            key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
    else:
        builder = (
            builder.add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer[1].public_key()), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        )
    return builder.sign(issuer[1] if issuer else key, hashes.SHA256()), key


def _pem(cert):
    return cert.public_bytes(serialization.Encoding.PEM).decode()


@pytest.fixture
def private_ca():
    return _certificate("Test CA")


async def _tls_server(tmp_path, ca, name):
    cert, key = _certificate(name, issuer=ca)
    chain = tmp_path / "chain.pem"
    chain.write_text(_pem(cert) + key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode())
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(chain)
    sni = []
    context.sni_callback = lambda _s, server_name, _c: sni.append(server_name)
    return await ModelServer(context).start(), sni


async def test_tls_verifies_and_names_the_host_with_a_models_own_ca(names, wire, monkeypatch, tmp_path, private_ca):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server, sni = await _tls_server(tmp_path, private_ca, NAME)
    try:
        client = adapter_for("custom", f"https://{NAME}:{server.port}/v1", ca_cert=_pem(private_ca[0]))
        resp = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    finally:
        await server.stop()
    assert resp.choices[0].message.content == "pong"
    assert sni == [NAME] and wire.dialled == ["127.0.0.1"]


async def test_tls_trusts_the_charts_custom_cas(names, wire, monkeypatch, tmp_path, private_ca, keys):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    (tmp_path / "ca.pem").write_text(_pem(private_ca[0]))
    monkeypatch.setenv("CUSTOM_CA_DIR", str(tmp_path))
    tls._custom_ca_files.cache_clear()
    certs = tmp_path / "server"
    certs.mkdir()
    server, sni = await _tls_server(certs, private_ca, NAME)
    try:
        out = await LIST_ROUTE({"provider": "custom", "api_key_env": "OPENAI_API_KEY", "base_url": f"https://{NAME}:{server.port}/v1"})
    finally:
        await server.stop()
    assert out == {"models": [{"name": "listed-model"}]} and sni == [NAME]


async def test_tls_refuses_a_certificate_for_another_name(names, wire, monkeypatch, tmp_path, private_ca):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server, _ = await _tls_server(tmp_path, private_ca, "other.example.test")
    try:
        with pytest.raises(httpx.ConnectError, match="CERTIFICATE_VERIFY_FAILED"):
            await api_public._list_models("custom", FAKE_KEY, f"https://{NAME}:{server.port}/v1", tls.build_verify(True, _pem(private_ca[0])))
    finally:
        await server.stop()
    assert server.requests == []


async def test_tls_verification_off_still_connects(names, wire, monkeypatch, tmp_path, private_ca):
    monkeypatch.setenv(LIST_VARIABLE, NAME)
    names.answer(NAME, "127.0.0.1")
    server, _ = await _tls_server(tmp_path, private_ca, "other.example.test")
    try:
        client = adapter_for("custom", f"https://{NAME}:{server.port}/v1", tls_verify=False)
        resp = await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    finally:
        await server.stop()
    assert resp.choices[0].message.content == "pong"


# A proxy from the environment: the operator's address, and the proxy resolves the model's name.

async def test_a_private_proxy_still_carries_the_request_and_resolves_the_name_itself(names, wire, server, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{server.port}")
    names.answer(NAME, PUBLIC)
    base = f"http://{NAME}:8080/v1"
    policy.check_base_url(base)
    names.asked.clear()
    resp = await adapter_for("custom", base).chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert resp.choices[0].message.content == "pong"
    assert server.requests[0]["line"].split()[1] == f"http://{NAME}:8080/v1/chat/completions"
    assert names.asked == [] and wire.dialled == ["127.0.0.1"]


async def test_https_through_a_proxy_asks_the_proxy_for_the_name(names, wire, server, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", f"http://127.0.0.1:{server.port}")
    names.answer(NAME, PUBLIC)
    with pytest.raises(httpx.ProxyError):
        await api_public._list_models("custom", FAKE_KEY, f"https://{NAME}:8443/v1", True)
    assert server.requests[0]["line"] == f"CONNECT {NAME}:8443 HTTP/1.1"
    assert names.asked == []


async def test_a_host_under_no_proxy_is_judged_as_a_direct_connection(names, wire, server, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{server.port}")
    monkeypatch.setenv("NO_PROXY", NAME)
    names.answer(NAME, "127.0.0.1")
    with pytest.raises(Exception):
        await api_public._list_models("custom", FAKE_KEY, f"http://{NAME}:{server.port}/v1", True)
    assert server.connections == 0, "the proxy or the address was reached"


# What nobody typed in: a provider's own address and the installer's OPENAI_BASE_URL. check_base_url does not read them.

async def test_ollamas_built_in_address_is_not_judged(wire):
    out = await TEST_ROUTE({"provider": "ollama", "model": "m"})
    assert out == {"success": False, "message": "Connection error."}
    assert wire.dialled and set(wire.dialled) <= {"127.0.0.1", "::1"}


async def test_the_chat_on_ollamas_built_in_address_goes_to_it(wire):
    client = ProviderAdapter(provider="ollama", model="m", api_key="")
    with pytest.raises(openai.APIConnectionError):
        await client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert wire.dialled and set(wire.dialled) <= {"127.0.0.1", "::1"}


@pytest.mark.parametrize("provider,host", [("openai", "api.openai.com"), ("anthropic", "api.anthropic.com"), ("gemini", "generativelanguage.googleapis.com")])
async def test_a_providers_own_address_may_resolve_to_a_private_one(names, wire, provider, host):
    """Company DNS often answers a provider's name with a private endpoint; no base_url means no address rule, as before."""
    names.answer(host, PRIVATE)
    with pytest.raises(Exception):
        await ProviderAdapter(provider=provider, model="m", api_key=FAKE_KEY).chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert set(wire.dialled) == {PRIVATE}


@pytest.mark.parametrize("body,host", [
    ({"provider": "openai"}, "api.openai.com"),
    ({"provider": "anthropic"}, "api.anthropic.com"),
    ({"provider": "gemini"}, "generativelanguage.googleapis.com"),
])
async def test_the_connection_test_on_a_providers_own_address_is_not_judged(names, wire, body, host):
    names.answer(host, PRIVATE)
    out = await TEST_ROUTE({**body, "model": "m", "api_key": FAKE_KEY})
    assert out["success"] is False
    assert set(wire.dialled) == {PRIVATE}
    assert PRIVATE not in out["message"]


async def test_the_model_list_on_a_providers_own_address_is_not_judged(names, wire, keys):
    names.answer("api.openai.com", PRIVATE)
    out = await LIST_ROUTE({"provider": "openai", "api_key_env": "OPENAI_API_KEY"})
    assert out["models"] == [] and out["error"].startswith("ConnectError")
    assert PRIVATE not in out["error"]
    assert wire.dialled == [PRIVATE]


async def test_the_installers_address_is_not_judged(names, wire, server, monkeypatch):
    """OPENAI_BASE_URL with no stored config: the chart's value, which the config rule never read."""
    from app import api
    from app.config import settings
    from app.services import model_config_service

    monkeypatch.setattr(settings, "OPENAI_BASE_URL", f"http://{NAME}:{server.port}/v1", raising=False)
    names.answer(NAME, "127.0.0.1")
    service = api._new_ai_service(model_config_service._build_resolved(None))
    resp = await service.client.chat.completions.create(model="m", messages=MESSAGES, max_tokens=5)
    assert resp.choices[0].message.content == "pong"
    assert server.connections == 1
