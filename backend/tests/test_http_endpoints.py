"""
Black-box HTTP tests using FastAPI's TestClient. No real Anthropic calls — we
verify the input-validation guard rails (size caps, key shape, slide-plan
shape, CORS allowlist, request-too-large) and the download artifact flow.
"""
import json

import pytest
from fastapi.testclient import TestClient

import main as backend_main


@pytest.fixture
def client():
    # Disable startup event side effects for simpler testing
    return TestClient(backend_main.app)


# ── Input validation rejects bad keys / oversized bodies ─────────────────────
def test_intake_rejects_bad_key(client):
    r = client.post("/api/intake", json={"api_key": "nope", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code in (400, 422)


def test_interpret_rejects_bad_key(client):
    r = client.post("/api/interpret", json={"api_key": "nope", "prompt": "anything"})
    assert r.status_code in (400, 422)


def test_generate_v2_rejects_oversized_section_count(client):
    plan = {
        "presentation_title": "X",
        "sections": [
            {"name": f"S{i}", "slides": [{"slide_type": "content"}]}
            for i in range(backend_main.MAX_SECTIONS + 1)
        ],
    }
    r = client.post("/api/generate_v2", json={
        "api_key": "sk-ant-validlookingkey1234567890_-",
        "slide_plan": plan,
    })
    assert r.status_code == 400
    assert "sections" in r.json()["detail"]


def test_generate_v2_rejects_oversized_content_slides(client):
    plan = {
        "presentation_title": "X",
        "sections": [
            {
                "name": "S",
                "slides": [{"slide_type": "content"}] * (backend_main.MAX_CONTENT_SLIDES + 1),
            }
        ],
    }
    r = client.post("/api/generate_v2", json={
        "api_key": "sk-ant-validlookingkey1234567890_-",
        "slide_plan": plan,
    })
    assert r.status_code == 400
    assert "content slides" in r.json()["detail"]


def test_generate_v2_rejects_zero_content(client):
    plan = {
        "presentation_title": "X",
        "sections": [{"name": "S", "slides": [{"slide_type": "section_divider"}]}],
    }
    r = client.post("/api/generate_v2", json={
        "api_key": "sk-ant-validlookingkey1234567890_-",
        "slide_plan": plan,
    })
    assert r.status_code == 400


def test_request_size_middleware_rejects_oversized(client):
    huge = "x" * (backend_main.MAX_REQUEST_BYTES + 1)
    body = json.dumps({"api_key": "sk-ant-validlookingkey1234567890_-", "prompt": huge})
    r = client.post(
        "/api/interpret",
        content=body,
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
    )
    assert r.status_code == 413


# ── CORS allow-list ──────────────────────────────────────────────────────────
def test_cors_blocks_disallowed_origin(client):
    r = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    # Starlette's CORS middleware does not echo the origin for non-allowed origins.
    assert r.headers.get("access-control-allow-origin") != "https://evil.example.com"


def test_cors_allows_configured_origin(client):
    r = client.options(
        "/api/health",
        headers={
            "Origin": "https://invescore-slide-studio.vercel.app",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "https://invescore-slide-studio.vercel.app"


# ── Health ───────────────────────────────────────────────────────────────────
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "template" in body


# ── Download endpoint: 404 on bad id / token ─────────────────────────────────
def test_download_invalid_id(client):
    r = client.get("/api/download/not-hex", headers={"X-Download-Token": "x" * 32})
    assert r.status_code == 404


def test_download_missing_token(client):
    r = client.get("/api/download/" + ("a" * 32))
    assert r.status_code == 404


def test_download_bad_token_returns_404_not_403(client):
    """Existence-leak protection: wrong token must not distinguish from missing file."""
    # Manually plant a fake artifact + meta
    backend_main.TMP_DIR.mkdir(parents=True, exist_ok=True)
    artifact_id = "0" * 32
    meta = backend_main._artifact_meta_path(artifact_id)
    pptx = backend_main._artifact_file_path(artifact_id)
    try:
        meta.write_text(json.dumps({
            "filename": "x.pptx",
            "token_sha256": backend_main._hash_download_token("right-token"),
            "created_at": 0,  # not in the 60s grace window
            "expires_at": 9999999999,
        }))
        pptx.write_bytes(b"PK\x03\x04fake-pptx")
        r = client.get(
            f"/api/download/{artifact_id}",
            headers={"X-Download-Token": "wrong-token"},
        )
        assert r.status_code == 404, "wrong token must return 404, not 403"
    finally:
        meta.unlink(missing_ok=True)
        pptx.unlink(missing_ok=True)


def test_download_correct_token_succeeds(client):
    backend_main.TMP_DIR.mkdir(parents=True, exist_ok=True)
    artifact_id = "1" * 32
    meta = backend_main._artifact_meta_path(artifact_id)
    pptx = backend_main._artifact_file_path(artifact_id)
    try:
        meta.write_text(json.dumps({
            "filename": "right.pptx",
            "token_sha256": backend_main._hash_download_token("right-token"),
            "created_at": 0,
            "expires_at": 9999999999,
        }))
        pptx.write_bytes(b"PK\x03\x04valid-bytes")
        r = client.get(
            f"/api/download/{artifact_id}",
            headers={"X-Download-Token": "right-token"},
        )
        assert r.status_code == 200
        assert r.content.startswith(b"PK")
    finally:
        meta.unlink(missing_ok=True)
        pptx.unlink(missing_ok=True)


def test_download_expired_returns_404(client):
    backend_main.TMP_DIR.mkdir(parents=True, exist_ok=True)
    artifact_id = "2" * 32
    meta = backend_main._artifact_meta_path(artifact_id)
    pptx = backend_main._artifact_file_path(artifact_id)
    try:
        meta.write_text(json.dumps({
            "filename": "expired.pptx",
            "token_sha256": backend_main._hash_download_token("right-token"),
            "created_at": 0,
            "expires_at": 1,  # expired
        }))
        pptx.write_bytes(b"PK\x03\x04")
        r = client.get(
            f"/api/download/{artifact_id}",
            headers={"X-Download-Token": "right-token"},
        )
        assert r.status_code == 404
    finally:
        meta.unlink(missing_ok=True)
        pptx.unlink(missing_ok=True)
