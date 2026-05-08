"""
Observability contracts:
  - Every response carries an X-Request-ID header.
  - The redacting log formatter scrubs Anthropic API keys.
  - Health surface includes version + limits for support.
"""
import logging


import main as backend_main


def test_request_id_header_present(client_factory):
    client = client_factory()
    r = client.get("/api/health")
    assert r.status_code == 200
    rid = r.headers.get("X-Request-ID")
    assert rid and len(rid) >= 8


def test_request_id_propagates_from_caller(client_factory):
    client = client_factory()
    r = client.get("/api/health", headers={"X-Request-ID": "trace-abc-123"})
    assert r.headers.get("X-Request-ID") == "trace-abc-123"


def test_health_exposes_limits(client_factory):
    client = client_factory()
    r = client.get("/api/health")
    body = r.json()
    assert body["version"] == "2.1.0"
    assert body["limits"]["max_sections"] == backend_main.MAX_SECTIONS
    assert body["limits"]["max_content_slides"] == backend_main.MAX_CONTENT_SLIDES


def test_redacting_formatter_strips_api_key():
    formatter = backend_main.RedactingFormatter("%(message)s")
    record = logging.LogRecord(
        name="t", level=logging.INFO, pathname="", lineno=0,
        msg="leaked sk-ant-api03-VERYSECRETKEYabcdef0123456789 into logs",
        args=None, exc_info=None,
    )
    formatted = formatter.format(record)
    assert "sk-ant-api03-VERYSECRETKEYabcdef0123456789" not in formatted
    assert "REDACTED" in formatted


def test_redacting_formatter_does_not_alter_safe_lines():
    formatter = backend_main.RedactingFormatter("%(message)s")
    record = logging.LogRecord(
        name="t", level=logging.INFO, pathname="", lineno=0,
        msg="generate_v2 done duration_s=4.2 fallbacks=0",
        args=None, exc_info=None,
    )
    assert formatter.format(record) == "generate_v2 done duration_s=4.2 fallbacks=0"
