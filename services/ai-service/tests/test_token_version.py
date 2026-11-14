"""Token revocation (H11): the token's "tv" is checked against auth-service's
current token_version, cached 30 s, bridged from cache for 5 min when
auth-service is down, refused with nothing cached."""
import time
import urllib.error

import pytest
from fastapi import HTTPException

from app import security


class FakeLookup:
    def __init__(self, version):
        self.version = version
        self.signed_out = frozenset()
        self.error = None
        self.calls = []

    def __call__(self, token, user_id):
        self.calls.append((token, user_id))
        if self.error is not None:
            raise self.error
        return self.version, self.signed_out


@pytest.fixture
def lookup(monkeypatch):
    fake = FakeLookup(3)
    monkeypatch.setattr(security, "_fetch_token_version", fake)
    monkeypatch.setattr(security, "AUTH_TOKEN_VERSION_URL", "http://auth-service.test/tv")
    security._tv_cache.clear()
    yield fake
    security._tv_cache.clear()


def _status(fn, *args):
    try:
        fn(*args)
    except HTTPException as e:
        return e.status_code, e.detail
    return 200, None


def test_matching_version_passes_and_is_cached(lookup):
    assert _status(security.check_token_version, "tok", "u1", 3) == (200, None)
    assert _status(security.check_token_version, "tok", "u1", 3) == (200, None)
    assert lookup.calls == [("tok", "u1")], "one lookup inside the cache window, with the token as credential"


def test_bumped_version_revokes_once_the_cache_expires(lookup):
    security.check_token_version("tok", "u1", 3)
    lookup.version = 4
    # Inside the cache window the old answer still stands.
    assert _status(security.check_token_version, "tok", "u1", 3) == (200, None)
    security._tv_cache["u1"] = (3, time.monotonic() - security.TOKEN_VERSION_CACHE_SECONDS - 1, frozenset())
    assert _status(security.check_token_version, "tok", "u1", 3) == (401, "Token revoked")
    # A token carrying the new version passes.
    assert _status(security.check_token_version, "tok2", "u1", 4) == (200, None)


def test_newer_token_refreshes_the_cache_at_once(lookup):
    security.check_token_version("tok", "u1", 3)
    # Role change + sign-in again inside the cache window: the new token
    # (tv 4) works at once, the old one stops, one ahead of auth-service fails.
    lookup.version = 4
    assert _status(security.check_token_version, "tok2", "u1", 4) == (200, None)
    assert len(lookup.calls) == 2, "the newer token forced a refetch"
    assert _status(security.check_token_version, "tok", "u1", 3) == (401, "Token revoked")
    assert _status(security.check_token_version, "tok9", "u1", 9) == (401, "Token revoked")


def test_unreachable_auth_service_fails_closed_without_cache(lookup):
    lookup.error = urllib.error.URLError("connection refused")
    assert _status(security.check_token_version, "tok", "u1", 3) == (401, "Token version unavailable")


def test_stale_cache_bridges_an_outage_then_expires(lookup):
    security.check_token_version("tok", "u1", 3)
    lookup.error = urllib.error.URLError("connection refused")
    security._tv_cache["u1"] = (3, time.monotonic() - security.TOKEN_VERSION_CACHE_SECONDS - 1, frozenset())
    assert _status(security.check_token_version, "tok", "u1", 3) == (200, None), "stale value inside 5 min still counts"
    assert _status(security.check_token_version, "tok", "u1", 2) == (401, "Token revoked"), "older than what was last seen"
    assert _status(security.check_token_version, "tok4", "u1", 4) == (200, None), "newer than the stale value is trusted (signature proves issue)"
    security._tv_cache["u1"] = (3, time.monotonic() - security.TOKEN_VERSION_STALE_SECONDS - 1, frozenset())
    assert _status(security.check_token_version, "tok", "u1", 3) == (401, "Token version unavailable")


def test_deleted_user_is_revoked_not_bridged(lookup):
    security.check_token_version("tok", "u1", 3)
    lookup.error = security.TokenRevokedError("auth-service 404")
    security._tv_cache["u1"] = (3, time.monotonic() - security.TOKEN_VERSION_CACHE_SECONDS - 1, frozenset())
    assert _status(security.check_token_version, "tok", "u1", 3) == (401, "Token revoked")
    assert "u1" not in security._tv_cache


def test_http_status_mapping(monkeypatch):
    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        body = b'{"tv": 7}'

        def read(self):
            return self.body

    def urlopen_ok(req, timeout):
        assert req.full_url.endswith("/u9") and req.get_header("Authorization") == "Bearer tok"
        return Resp()

    monkeypatch.setattr(security.urllib.request, "urlopen", urlopen_ok)
    assert security._fetch_token_version("tok", "u9") == (7, frozenset()), "an older auth-service lists none"
    Resp.body = b'{"tv": 7, "signed_out": [1763100000, 1763100042]}'
    assert security._fetch_token_version("tok", "u9") == (7, frozenset({1763100000, 1763100042}))

    def urlopen_403(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    monkeypatch.setattr(security.urllib.request, "urlopen", urlopen_403)
    with pytest.raises(security.TokenRevokedError):
        security._fetch_token_version("tok", "u9")

    def urlopen_502(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 502, "Bad Gateway", {}, None)

    monkeypatch.setattr(security.urllib.request, "urlopen", urlopen_502)
    with pytest.raises(urllib.error.HTTPError):
        security._fetch_token_version("tok", "u9")


def test_check_is_off_without_a_url(monkeypatch):
    monkeypatch.setattr(security, "AUTH_TOKEN_VERSION_URL", "")
    monkeypatch.setattr(security, "_fetch_token_version", FakeLookup(99))
    assert _status(security.check_token_version, "tok", "u1", 1) == (200, None)


def test_a_key_token_is_cached_apart_from_the_users_sign_in(lookup):
    """auth-service answers "revoked" for a token whose API key was deleted; the user's sign-in token refreshing its
    own entry must not let the key's token ride on it."""
    def fetch(token, user_id):
        lookup.calls.append((token, user_id))
        if token == "key-tok" and lookup.error is not None:
            raise lookup.error
        return 3, frozenset()
    security._fetch_token_version = fetch  # restored by monkeypatch teardown of the fixture's attribute
    assert _status(security.check_token_version, "key-tok", "u1", 3, "key-1") == (200, None)
    lookup.error = security.TokenRevokedError()
    security._tv_cache["u1|key-1"] = (3, time.monotonic() - security.TOKEN_VERSION_CACHE_SECONDS - 1, frozenset())  # due
    assert _status(security.check_token_version, "sign-in", "u1", 3) == (200, None)  # refreshes "u1"
    assert _status(security.check_token_version, "key-tok", "u1", 3, "key-1") == (401, "Token revoked")


def test_a_signed_out_sign_in_is_refused_and_the_users_other_sign_ins_pass(lookup):
    lookup.signed_out = frozenset({1763100000})
    assert _status(security.check_token_version, "tok-a", "u1", 3, "", 1763100001) == (200, None)
    assert _status(security.check_token_version, "tok-b", "u1", 3, "", 1763100000) == (401, "Token revoked")
    assert len(lookup.calls) == 1, "one answer per user serves every sign-in of that user"
    assert _status(security.check_token_version, "key-tok", "u1", 3, "key-1", 0) == (200, None), "a key's token is no sign-in"


def test_a_sign_out_seen_before_an_outage_stays_refused(lookup):
    lookup.signed_out = frozenset({1763100000})
    security.check_token_version("tok-a", "u1", 3, "", 1763100001)
    lookup.error = urllib.error.URLError("connection refused")
    security._tv_cache["u1"] = (3, time.monotonic() - security.TOKEN_VERSION_CACHE_SECONDS - 1, frozenset({1763100000}))
    assert _status(security.check_token_version, "tok-b", "u1", 3, "", 1763100000) == (401, "Token revoked")
    assert _status(security.check_token_version, "tok-a", "u1", 3, "", 1763100001) == (200, None)


def test_the_sign_in_of_a_token_is_its_auth_time_and_no_key_or_system_token_has_one():
    assert security.sign_in_of({"auth_time": 100, "iat": 200}) == 100
    assert security.sign_in_of({"iat": 200}) == 200
    assert security.sign_in_of({"auth_time": 100, "akid": "k1"}) == 0
    assert security.sign_in_of({"auth_time": 100, "sys": "investigator"}) == 0
    assert security.sign_in_of({}) == 0


def test_a_token_of_a_signed_out_sign_in_is_refused_when_it_is_read(lookup, monkeypatch):
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(security, "_jwk_client", type("JWK", (), {"get_signing_key_from_jwt": lambda self, _t: type("K", (), {"key": key.public_key()})})())
    now = int(time.time())

    def token(auth_time):
        return jwt.encode({"sub": "u1", "email": "u1@example.com", "role": "Member", "permissions": {"c": ["resource.*.read"]}, "tv": 3,
                           "auth_time": auth_time, "iss": security.JWT_ISSUER, "aud": security.JWT_AUDIENCE, "iat": now, "exp": now + 300},
                          key, algorithm="RS256")

    lookup.signed_out = frozenset({now - 3600})
    assert security.decode_access_token(token(now - 3599)).user_id == "u1"
    with pytest.raises(HTTPException) as refused:
        security.decode_access_token(token(now - 3600))
    assert (refused.value.status_code, refused.value.detail) == (401, "Token revoked")
