"""What the connection test says of a refusal: the status and the provider's own error message. An address on the allow list
may be a service that is no model API, and the text of its page has no business in an admin's window or an audit row."""
import httpx
import pytest

from app import api_public

KEY = "fake-provider-key-1"
PAGE = "<html>fake-internal-page</html>"


def serve(monkeypatch, handler):
    real = httpx.AsyncClient

    class Client(real):
        def __init__(self, **kw):
            kw.pop("verify", None)
            super().__init__(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(httpx, "AsyncClient", Client)


def page(status=502, text=PAGE, content_type="text/html; charset=utf-8"):
    return lambda request: httpx.Response(status, text=text, headers={"content-type": content_type})


def error(status, body):
    return lambda request: httpx.Response(status, json=body)


async def anthropic():
    return await api_public._test_anthropic(KEY, "m")


async def google():
    return await api_public._test_google(KEY, "m")


async def openai_compatible():
    return await api_public._test_model_connection({"provider": "openai", "model": "m", "api_key": KEY})


async def ollama():
    return await api_public._test_model_connection({"provider": "ollama", "model": "m"})


PATHS = [anthropic, google, openai_compatible, ollama]
IDS = ["anthropic", "google", "openai-compatible", "ollama"]


@pytest.mark.asyncio
@pytest.mark.parametrize("call", PATHS, ids=IDS)
async def test_a_page_that_is_no_model_api_stays_out_of_the_answer(monkeypatch, call):
    serve(monkeypatch, page(status=403))
    out = await call()
    assert out["success"] is False
    assert "fake-internal-page" not in out["message"]
    assert "HTTP 403" in out["message"] and "text/html" in out["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("call", PATHS, ids=IDS)
async def test_json_that_holds_no_error_stays_out_of_the_answer(monkeypatch, call):
    serve(monkeypatch, error(403, {"rows": ["fake-internal-row"]}))
    out = await call()
    assert out["success"] is False
    assert "fake-internal-row" not in out["message"]
    assert "HTTP 403" in out["message"] and "application/json" in out["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("call", PATHS, ids=IDS)
@pytest.mark.parametrize("body,said", [
    ({"error": {"message": "invalid x-api-key", "type": "authentication_error"}}, "invalid x-api-key"),
    ({"error": "model not found, try pulling it"}, "model not found, try pulling it"),
    ({"message": "Forbidden by the gateway"}, "Forbidden by the gateway"),
    ({"detail": "No such deployment"}, "No such deployment"),
], ids=["a provider's error", "ollama's error", "a gateway's message", "a framework's detail"])
async def test_the_providers_own_error_message_stays(monkeypatch, call, body, said):
    serve(monkeypatch, error(403, body))
    out = await call()
    assert out["success"] is False
    assert out["message"] == f"HTTP 403: {said}"


@pytest.mark.asyncio
@pytest.mark.parametrize("call", PATHS, ids=IDS)
async def test_a_long_error_message_is_cut_and_a_credential_in_it_goes(monkeypatch, call):
    long = "x" * 5000
    serve(monkeypatch, error(403, {"error": {"message": f"bad key {KEY} password=fake-pass-1 {long}"}}))
    out = await call()
    assert out["success"] is False
    # Ollama's test sends no key, so it has none to know
    assert call is ollama or KEY not in out["message"]
    assert "fake-pass-1" not in out["message"]
    assert len(out["message"]) < 400


@pytest.mark.asyncio
async def test_googles_quota_answer_still_means_the_key_works(monkeypatch):
    serve(monkeypatch, error(429, {"error": {"message": "quota"}}))
    out = await google()
    assert out["success"] is True and "quota warning" in out["message"]


@pytest.mark.asyncio
async def test_a_connection_that_never_answered_still_says_why(monkeypatch):
    def refused(request):
        raise httpx.ConnectError("connection refused")

    serve(monkeypatch, refused)
    out = await anthropic_through_the_route()
    assert out["success"] is False and "connection refused" in out["message"].lower()


async def anthropic_through_the_route():
    return await api_public._test_model_connection({"provider": "anthropic", "model": "m", "api_key": KEY})
