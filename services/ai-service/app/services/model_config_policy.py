"""What an operator-supplied model configuration may do.

A model config names an environment variable for the key, a base URL the
service will send that key to, and extra headers that ride along. Anyone with
admin.ai_models.* could point `api_key_env` at any variable of this process
(the database URL, say) and `base_url` at their own server, and every chat
would hand the value over. These checks run when a config is created,
updated, tested and resolved for use:

  - api_key_env: only the key variables the chart ships (OPENAI_API_KEY,
    ANTHROPIC_API_KEY, GEMINI_API_KEY) or names starting with
    KUBEAST_AI_KEY_ (operators add those to the secret).
  - base_url: http(s) only, no credentials, and every address the host
    resolves to must be public — never cloud metadata, loopback, link-local
    or private ranges — unless the host is listed in
    AI_BASE_URL_ALLOWED_HOSTS (an in-cluster Ollama or LLM gateway).
  - extra_headers: no authentication headers (the key travels via
    api_key_env only), and they are masked in responses.
"""
import ipaddress
import os
import re
import socket
from typing import Callable, Dict, Iterable, List, Optional
from urllib.parse import urlsplit

API_KEY_ENV_PREFIX = "KUBEAST_AI_KEY_"
API_KEY_ENV_NAMES = frozenset({"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"})
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")

AUTH_HEADERS = frozenset({
    "authorization", "proxy-authorization", "x-api-key", "api-key",
    "x-goog-api-key", "anthropic-api-key", "ocp-apim-subscription-key",
})

# Cloud instance metadata: never, whatever the allow-list says.
METADATA_HOSTS = frozenset({"metadata.google.internal", "metadata", "instance-data"})
METADATA_NETWORKS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fd00:ec2::254/128"))
# Not reachable from the internet: only with the host on the allow-list.
PRIVATE_NETWORKS = (
    ipaddress.ip_network("0.0.0.0/8"), ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"), ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::/128"), ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"), ipaddress.ip_network("fe80::/10"),
)

MASK = "***"


class PolicyError(ValueError):
    """A model configuration the service will not accept."""


def allowed_hosts() -> List[str]:
    """AI_BASE_URL_ALLOWED_HOSTS: exact hosts, or ".suffix" entries that match
    the host and every subdomain. Read on every call so a redeploy with a new
    value needs no restart logic."""
    return [h.strip().lower() for h in os.getenv("AI_BASE_URL_ALLOWED_HOSTS", "").split(",") if h.strip()]


def _host_allowed(host: str, allowed: Iterable[str]) -> bool:
    for a in allowed:
        if a.startswith("."):
            if host == a[1:] or host.endswith(a):
                return True
        elif host == a:
            return True
    return False


def check_api_key_env(name: Optional[str]) -> None:
    if not name:
        return
    if name in API_KEY_ENV_NAMES:
        return
    if name.startswith(API_KEY_ENV_PREFIX) and len(name) > len(API_KEY_ENV_PREFIX) and _ENV_NAME.match(name):
        return
    raise PolicyError(
        f"api_key_env must be one of {', '.join(sorted(API_KEY_ENV_NAMES))} or start with {API_KEY_ENV_PREFIX}"
    )


def check_extra_headers(headers: Optional[Dict[str, str]]) -> None:
    for k in headers or {}:
        if k.strip().lower() in AUTH_HEADERS:
            raise PolicyError(f"extra_headers must not carry an authentication header ({k}); use api_key_env")


def mask_headers(headers: Optional[Dict[str, str]]) -> Dict[str, str]:
    return {k: MASK for k in (headers or {})}


def _addresses(host: str, resolve: Callable[..., list]) -> List[ipaddress._BaseAddress]:
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    try:
        infos = resolve(host, None)
    except OSError as e:
        raise PolicyError(f"base_url host does not resolve: {host}") from e
    addrs = []
    for info in infos:
        try:
            addrs.append(ipaddress.ip_address(info[4][0]))
        except (ValueError, IndexError, TypeError):
            continue
    if not addrs:
        raise PolicyError(f"base_url host does not resolve: {host}")
    return addrs


def check_base_url(url: Optional[str], resolve: Callable[..., list] = socket.getaddrinfo) -> None:
    """Reject anything but a public http(s) endpoint (or an allow-listed host).
    `resolve` is socket.getaddrinfo; tests inject a fake."""
    if not url:
        return
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PolicyError("base_url must be an http(s) URL")
    if parts.username or parts.password:
        raise PolicyError("base_url must not contain credentials")
    host = parts.hostname.lower()
    if host in METADATA_HOSTS:
        raise PolicyError("base_url host is not allowed")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and any(literal in net for net in METADATA_NETWORKS):
        raise PolicyError("base_url host is not allowed")
    if _host_allowed(host, allowed_hosts()):
        # The operator vouched for this host (an in-cluster model server, a
        # gateway only cluster DNS resolves): no address check.
        return
    for ip in _addresses(host, resolve):
        if any(ip in net for net in METADATA_NETWORKS):
            raise PolicyError("base_url host is not allowed")
        if any(ip in net for net in PRIVATE_NETWORKS):
            raise PolicyError(
                f"base_url host resolves to a private address ({ip}); list it in AI_BASE_URL_ALLOWED_HOSTS to allow it"
            )
