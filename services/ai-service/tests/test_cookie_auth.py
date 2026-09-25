"""bearer_or_cookie: the browser session cookie is accepted as a credential,
and a cookie-authenticated request that can change state must carry
X-Requested-With (CSRF). Bearer calls are exempt."""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.security import AUTH_COOKIE_NAME, bearer_or_cookie


def _client(cookie: str = "") -> TestClient:
    app = FastAPI()

    @app.get("/r")
    async def read(cred: str = Depends(bearer_or_cookie)):
        return {"cred": cred}

    @app.post("/w")
    async def write(cred: str = Depends(bearer_or_cookie)):
        return {"cred": cred}

    c = TestClient(app)
    if cookie:
        c.cookies.set(AUTH_COOKIE_NAME, cookie)
    return c


CSRF = {"X-Requested-With": "XMLHttpRequest"}


def test_no_credential_is_401():
    c = _client()
    assert c.get("/r").status_code == 401
    assert c.post("/w", headers=CSRF).status_code == 401


def test_cookie_read_needs_no_header():
    r = _client("tok").get("/r")
    assert r.status_code == 200
    assert r.json()["cred"] == "Bearer tok"


def test_cookie_write_without_header_is_403():
    assert _client("tok").post("/w").status_code == 403


def test_cookie_write_with_header_passes():
    r = _client("tok").post("/w", headers=CSRF)
    assert r.status_code == 200
    assert r.json()["cred"] == "Bearer tok"


def test_bearer_write_is_exempt_and_wins_over_cookie():
    r = _client("cookie-tok").post("/w", headers={"Authorization": "Bearer api-tok"})
    assert r.status_code == 200
    assert r.json()["cred"] == "Bearer api-tok"
