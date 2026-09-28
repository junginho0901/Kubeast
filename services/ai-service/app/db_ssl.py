"""Translate libpq-style TLS parameters in DATABASE_URL for asyncpg.

The same DATABASE_URL is handed to every service. The Go services (pgx) read
``sslmode`` / ``sslrootcert`` from the URL natively; SQLAlchemy's asyncpg
dialect instead forwards unknown query parameters as keyword arguments to
``asyncpg.connect()``, which has no ``sslmode`` and fails. So the ai-service
strips them here and passes an equivalent ``ssl`` connect argument:

- no sslmode              -> nothing (asyncpg default, ``prefer``)
- disable/allow/prefer/require, no CA -> the same mode string
- verify-ca / verify-full, no CA      -> the mode string (system trust store)
- any mode with sslrootcert           -> an SSLContext trusting that CA;
                                         hostname check only for verify-full
"""
from __future__ import annotations

import ssl
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SSL_PARAMS = ("sslmode", "sslrootcert")
SSL_MODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")


def split_ssl_params(url: str) -> tuple[str, dict[str, Any]]:
    """Return (url without sslmode/sslrootcert, connect_args for asyncpg)."""
    parts = urlsplit(url)
    if not parts.query:
        return url, {}
    kept: list[tuple[str, str]] = []
    mode = None
    rootcert = None
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key == "sslmode":
            mode = value
        elif key == "sslrootcert":
            rootcert = value
        else:
            kept.append((key, value))
    clean = urlunsplit(parts._replace(query=urlencode(kept)))
    if mode is None and rootcert is None:
        return url, {}
    if mode is not None and mode not in SSL_MODES:
        raise ValueError(f"DATABASE_URL: unknown sslmode {mode!r} (expected one of {', '.join(SSL_MODES)})")
    return clean, {"ssl": _ssl_argument(mode, rootcert)}


def _ssl_argument(mode: str | None, rootcert: str | None) -> Any:
    if rootcert:
        if mode == "disable":
            return "disable"
        # Trust exactly the given CA (RDS bundle, a company CA) instead of the
        # system store; verify-full also checks the host name.
        ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=rootcert)
        ctx.check_hostname = mode == "verify-full"
        ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx
    return mode
