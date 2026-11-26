"""sslmode / sslrootcert in DATABASE_URL become an asyncpg `ssl` connect argument."""
import datetime
import ssl

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

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
        verify_flags = ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN

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
    assert ctx.verify_flags == ssl.VERIFY_X509_PARTIAL_CHAIN

    _, args = db_ssl.split_ssl_params(f"{BASE}?sslmode=verify-ca&sslrootcert=/etc/kubeast/db-ca/ca.crt")
    assert args["ssl"].check_hostname is False


def test_unknown_mode_is_rejected():
    with pytest.raises(ValueError, match="unknown sslmode"):
        db_ssl.split_ssl_params(f"{BASE}?sslmode=please")


# A real handshake in memory: the server certificate has no Authority Key
# Identifier, which libpq and pgx take and VERIFY_X509_STRICT refuses.

def _name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _ca(cn):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(cn))
        .issuer_name(_name(cn))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False,
                          key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def _server_without_aki(ca_key, ca_cert, host):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(host))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    return key, cert


@pytest.fixture
def db_tls(tmp_path):
    ca_key, ca_cert = _ca("Kubeast test DB CA")
    other_key, other_cert = _ca("Another CA")
    files = {}
    for name, (key, cert) in {
        "server": _server_without_aki(ca_key, ca_cert, "db.example"),
        "other": _server_without_aki(other_key, other_cert, "db.example"),
    }.items():
        (tmp_path / f"{name}.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (tmp_path / f"{name}.key").write_bytes(
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        )
        files[name] = (str(tmp_path / f"{name}.crt"), str(tmp_path / f"{name}.key"))
    (tmp_path / "ca.crt").write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    return str(tmp_path / "ca.crt"), files


def _handshake(client_ctx, server_files, hostname):
    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(*server_files)
    c_in, c_out, s_in, s_out = ssl.MemoryBIO(), ssl.MemoryBIO(), ssl.MemoryBIO(), ssl.MemoryBIO()
    client = client_ctx.wrap_bio(c_in, c_out, server_hostname=hostname)
    server = server_ctx.wrap_bio(s_in, s_out, server_side=True)
    client_done = server_done = False
    for _ in range(20):
        if not client_done:
            try:
                client.do_handshake()
                client_done = True
            except ssl.SSLWantReadError:
                pass
        s_in.write(c_out.read())
        if not server_done:
            try:
                server.do_handshake()
                server_done = True
            except ssl.SSLWantReadError:
                pass
        c_in.write(s_out.read())
        if client_done and server_done:
            return
    raise AssertionError("the handshake did not finish")


def _context(mode, ca):
    _, args = db_ssl.split_ssl_params(f"{BASE}?sslmode={mode}&sslrootcert={ca}")
    return args["ssl"]


def test_the_strict_flag_alone_refuses_the_test_chain(db_tls):
    ca, files = db_tls
    strict = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=ca)
    strict.verify_flags |= ssl.VERIFY_X509_STRICT
    with pytest.raises(ssl.SSLCertVerificationError, match="Authority Key Identifier"):
        _handshake(strict, files["server"], "db.example")
    strict.verify_flags &= ~ssl.VERIFY_X509_STRICT
    _handshake(strict, files["server"], "db.example")


def test_verify_full_takes_a_chain_libpq_takes_and_still_checks_chain_and_host(db_tls):
    ca, files = db_tls
    ctx = _context("verify-full", ca)
    assert not ctx.verify_flags & ssl.VERIFY_X509_STRICT
    assert ctx.check_hostname is True
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    _handshake(ctx, files["server"], "db.example")
    with pytest.raises(ssl.SSLCertVerificationError, match="[Hh]ostname mismatch"):
        _handshake(_context("verify-full", ca), files["server"], "other.example")
    with pytest.raises(ssl.SSLCertVerificationError, match="unable to get local issuer certificate"):
        _handshake(_context("verify-full", ca), files["other"], "db.example")


@pytest.mark.parametrize("mode", ["require", "verify-ca"])
def test_a_ca_without_verify_full_checks_the_chain_and_not_the_host(db_tls, mode):
    ca, files = db_tls
    ctx = _context(mode, ca)
    assert not ctx.verify_flags & ssl.VERIFY_X509_STRICT
    _handshake(ctx, files["server"], "other.example")
    with pytest.raises(ssl.SSLCertVerificationError, match="unable to get local issuer certificate"):
        _handshake(_context(mode, ca), files["other"], "db.example")
