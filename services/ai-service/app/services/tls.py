"""TLS verification for calls to model providers.

httpx verifies against certifi's bundle by default, and lets SSL_CERT_FILE or
SSL_CERT_DIR replace that bundle. The chart's customCAs reach this service as
CUSTOM_CA_DIR instead: every file there is added on top of certifi, and a
model's own CA (Admin → AI Models) on top of that.
"""
from __future__ import annotations

import os
import ssl
from functools import lru_cache
from typing import Optional, Union

import certifi


@lru_cache(maxsize=1)
def _custom_ca_files() -> tuple[str, ...]:
    directory = os.environ.get("CUSTOM_CA_DIR", "").strip()
    if not directory or not os.path.isdir(directory):
        return ()
    files = []
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not name.startswith(".") and os.path.isfile(path):
            files.append(path)
    return tuple(files)


def build_verify(tls_verify: bool = True, ca_cert: Optional[str] = None) -> Union[bool, ssl.SSLContext]:
    """The ``verify`` argument for an httpx client.

    False when verification is off; True (httpx's default, certifi) when there
    is nothing to add; otherwise a context with certifi, the mounted CAs and
    the model's CA.
    """
    if not tls_verify:
        return False
    extra = _custom_ca_files()
    model_ca = (ca_cert or "").strip()
    if not extra and not model_ca:
        return True
    ctx = ssl.create_default_context(cafile=certifi.where())
    for path in extra:
        ctx.load_verify_locations(cafile=path)
    if model_ca:
        ctx.load_verify_locations(cadata=model_ca)
    return ctx
