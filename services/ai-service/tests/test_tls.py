"""TLS verification for model providers (app.services.tls): the chart's customCAs (CUSTOM_CA_DIR) and a model's own
CA are trusted on top of certifi, by the chat client and by the connection test and model list alike."""
import datetime
import ipaddress
import ssl
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app import api_public
from app.services import tls


def _cert(subject_cn, issuer_cert=None, issuer_key=None, ca=False):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject_cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer_cert.subject if issuer_cert else name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    # Python 3.13+ verifies strictly (VERIFY_X509_STRICT): key identifiers and key usage, like a real CA's.
    if ca:
        builder = builder.add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
            key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
    else:
        builder = (
            builder.add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        )
    cert = builder.sign(issuer_key or key, hashes.SHA256())
    return cert, key


def _pem(cert):
    return cert.public_bytes(serialization.Encoding.PEM).decode()


@pytest.fixture
def ca():
    return _cert("Kubeast Test CA", ca=True)


@pytest.fixture(autouse=True)
def fresh_dir_cache():
    tls._custom_ca_files.cache_clear()
    yield
    tls._custom_ca_files.cache_clear()


def _subjects(ctx):
    return {dict(x[0] for x in c["subject"]).get("commonName") for c in ctx.get_ca_certs()}


def test_nothing_to_add_keeps_httpx_default(monkeypatch):
    monkeypatch.delenv("CUSTOM_CA_DIR", raising=False)
    assert tls.build_verify() is True
    assert tls.build_verify(False, "anything") is False


def test_mounted_cas_go_on_top_of_certifi(monkeypatch, tmp_path, ca):
    (tmp_path / "corp.crt").write_text(_pem(ca[0]))
    (tmp_path / ".hidden").write_text("not a certificate")
    (tmp_path / "subdir").mkdir()
    monkeypatch.setenv("CUSTOM_CA_DIR", str(tmp_path))
    ctx = tls.build_verify()
    assert isinstance(ctx, ssl.SSLContext)
    subjects = _subjects(ctx)
    assert "Kubeast Test CA" in subjects
    assert len(subjects) > 100, "certifi's public roots are kept"


def test_a_model_ca_adds_to_the_mounted_ones(monkeypatch, tmp_path, ca):
    other = _cert("Model Only CA", ca=True)
    monkeypatch.delenv("CUSTOM_CA_DIR", raising=False)
    assert "Model Only CA" in _subjects(tls.build_verify(True, _pem(other[0])))
    tls._custom_ca_files.cache_clear()
    (tmp_path / "corp.crt").write_text(_pem(ca[0]))
    monkeypatch.setenv("CUSTOM_CA_DIR", str(tmp_path))
    both = _subjects(tls.build_verify(True, _pem(other[0])))
    assert {"Kubeast Test CA", "Model Only CA"} <= both


def test_handshake_with_a_server_signed_by_the_mounted_ca(monkeypatch, tmp_path, ca):
    ca_cert, ca_key = ca
    server_cert, server_key = _cert("127.0.0.1", ca_cert, ca_key)
    chain = tmp_path / "server.pem"
    chain.write_text(_pem(server_cert) + server_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode())

    class Ok(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Ok)
    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sctx.load_cert_chain(chain)
    srv.socket = sctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"https://127.0.0.1:{srv.server_address[1]}/"
    try:
        monkeypatch.delenv("CUSTOM_CA_DIR", raising=False)
        with pytest.raises(httpx.ConnectError):
            httpx.get(url, verify=tls.build_verify())
        tls._custom_ca_files.cache_clear()
        cadir = tmp_path / "ca"
        cadir.mkdir()
        (cadir / "corp.crt").write_text(_pem(ca_cert))
        monkeypatch.setenv("CUSTOM_CA_DIR", str(cadir))
        assert httpx.get(url, verify=tls.build_verify()).text == "ok"
    finally:
        srv.shutdown()


@pytest.mark.asyncio
async def test_model_list_names_an_untrusted_certificate(monkeypatch):
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)

    async def untrusted(provider, api_key, base, verify):
        raise httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate")

    monkeypatch.setattr(api_public, "_list_models", untrusted)
    out = await api_public.list_provider_models({"provider": "ollama", "base_url": "https://llm.internal"})
    assert out["models"] == [] and "add its CA" in out["error"]


@pytest.mark.asyncio
async def test_connection_test_and_model_list_use_the_model_ca(monkeypatch, ca):
    """These two used to ignore ca_cert: a model behind a private CA chatted but failed both."""
    monkeypatch.delenv("CUSTOM_CA_DIR", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(api_public, "_validate_base_url", lambda url: None)
    seen = {}

    async def fake_list(provider, api_key, base, verify):
        seen["list"] = verify
        return []

    async def fake_test(api_key, model, base, verify):
        seen["test"] = verify
        return {"success": True}

    monkeypatch.setattr(api_public, "_list_models", fake_list)
    monkeypatch.setattr(api_public, "_test_openai_compatible", fake_test)
    body = {"provider": "openai", "api_key_env": "OPENAI_API_KEY", "base_url": "https://llm.internal/v1", "ca_cert": _pem(ca[0])}
    await api_public.list_provider_models(dict(body))
    await api_public.test_model_connection(dict(body, model="m"))
    for which in ("list", "test"):
        assert isinstance(seen[which], ssl.SSLContext) and "Kubeast Test CA" in _subjects(seen[which]), which
