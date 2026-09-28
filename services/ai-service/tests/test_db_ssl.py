"""sslmode / sslrootcert in DATABASE_URL become an asyncpg `ssl` connect argument."""
import ssl

import pytest

from app import db_ssl

BASE = "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast"


def test_url_without_ssl_params_is_untouched():
    assert db_ssl.split_ssl_params(BASE) == (BASE, {})
    url = BASE + "?application_name=ai"
    assert db_ssl.split_ssl_params(url) == (url, {})


@pytest.mark.parametrize("mode", ["disable", "prefer", "require", "verify-full"])
def test_mode_without_ca_is_passed_as_string(mode):
    clean, args = db_ssl.split_ssl_params(f"{BASE}?sslmode={mode}")
    assert clean == BASE
    assert args == {"ssl": mode}


def test_other_query_params_are_kept():
    clean, args = db_ssl.split_ssl_params(f"{BASE}?application_name=ai&sslmode=require&connect_timeout=5")
    assert clean == f"{BASE}?application_name=ai&connect_timeout=5"
    assert args == {"ssl": "require"}


def test_rootcert_builds_a_context_trusting_that_ca(monkeypatch):
    seen = {}

    class FakeCtx:
        check_hostname = None
        verify_mode = None

    def fake_default_context(purpose, cafile=None):
        seen["purpose"] = purpose
        seen["cafile"] = cafile
        return FakeCtx()

    monkeypatch.setattr(ssl, "create_default_context", fake_default_context)

    clean, args = db_ssl.split_ssl_params(f"{BASE}?sslmode=verify-full&sslrootcert=/etc/kubeast/db-ca/ca.crt")
    assert clean == BASE
    ctx = args["ssl"]
    assert seen == {"purpose": ssl.Purpose.SERVER_AUTH, "cafile": "/etc/kubeast/db-ca/ca.crt"}
    assert ctx.check_hostname is True
    assert ctx.verify_mode == ssl.CERT_REQUIRED

    _, args = db_ssl.split_ssl_params(f"{BASE}?sslmode=verify-ca&sslrootcert=/etc/kubeast/db-ca/ca.crt")
    assert args["ssl"].check_hostname is False


def test_unknown_mode_is_rejected():
    with pytest.raises(ValueError, match="unknown sslmode"):
        db_ssl.split_ssl_params(f"{BASE}?sslmode=please")
