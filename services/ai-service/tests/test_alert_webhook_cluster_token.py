"""A webhook token per cluster, so one cluster's Alertmanager config cannot post for another. The shared token keeps
working until an install turns it off: receivers already set up go on as they are."""
import hashlib
import hmac
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.investigation import webhook
from app.services.investigation.settings import load

SHARED = "fake-shared-webhook-token"
BODY = {"version": "4", "status": "firing", "alerts": [{"status": "firing", "labels": {"alertname": "X", "severity": "info"}}]}


def cluster_token(cluster):
    """As the documented openssl line makes it, from the shared token and the cluster ID."""
    return hmac.new(SHARED.encode(), cluster.encode(), hashlib.sha256).hexdigest()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ALERT_INVESTIGATION_ENABLED", "true")
    monkeypatch.setenv("ALERT_WEBHOOK_TOKEN", SHARED)
    monkeypatch.delenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", raising=False)
    rows = []

    async def write(**kw):
        rows.append(kw)
        return True

    async def fake_db():
        return None

    async def exists(_db, _cluster):
        return True

    async def gate(_db, _cfg, _cluster, msg, _now):
        return {"accepted": 0, "stored": len(msg.alerts)}

    monkeypatch.setattr(webhook, "write_audit", write)
    monkeypatch.setattr(webhook, "get_db_service", fake_db)
    monkeypatch.setattr(webhook.store, "cluster_exists", exists)
    monkeypatch.setattr(webhook, "gate_and_queue", gate)
    app = FastAPI()
    app.include_router(webhook.router, prefix="/api/v1/alerts")
    return SimpleNamespace(http=TestClient(app), rows=rows)


def post(c, cluster, token):
    return c.http.post(f"/api/v1/alerts/webhook?cluster={cluster}", json=BODY, headers={"Authorization": f"Bearer {token}"})


def test_a_receiver_set_up_with_the_shared_token_keeps_working(client):
    for cluster in ("alpha", "beta"):
        assert post(client, cluster, SHARED).status_code == 200
    assert client.rows == []


def test_a_clusters_token_posts_for_that_cluster(client):
    assert post(client, "alpha", cluster_token("alpha")).status_code == 200
    assert post(client, "beta", cluster_token("beta")).status_code == 200
    assert client.rows == []


def test_a_clusters_token_does_not_post_for_another(client):
    response = post(client, "beta", cluster_token("alpha"))
    assert response.status_code == 401
    assert client.rows[-1]["action"] == "alert.webhook.refuse" and client.rows[-1]["cluster"] == "beta"
    assert client.rows[-1]["after"] == {"reason": "token mismatch"}


def test_with_cluster_tokens_only_the_shared_token_stops(client, monkeypatch):
    monkeypatch.setenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", "true")
    response = post(client, "alpha", SHARED)
    assert response.status_code == 401
    assert client.rows[-1]["after"] == {"reason": "shared token refused"}
    assert post(client, "alpha", cluster_token("alpha")).status_code == 200


def test_with_cluster_tokens_only_a_call_without_a_cluster_is_refused(client, monkeypatch):
    monkeypatch.setenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", "true")
    assert client.http.post("/api/v1/alerts/webhook", json=BODY, headers={"Authorization": f"Bearer {SHARED}"}).status_code == 401


def test_a_call_without_a_cluster_still_says_what_is_missing_with_the_shared_token(client):
    response = client.http.post("/api/v1/alerts/webhook", json=BODY, headers={"Authorization": f"Bearer {SHARED}"})
    assert response.status_code == 400 and "cluster query parameter" in response.json()["detail"]


def test_spaces_around_the_cluster_name_the_same_cluster(client):
    assert post(client, "%20alpha%20", cluster_token("alpha")).status_code == 200


def test_the_switch_is_off_unless_set(monkeypatch):
    monkeypatch.delenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", raising=False)
    assert getattr(load(), "webhook_cluster_tokens_only", False) is False
    monkeypatch.setenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", "true")
    assert getattr(load(), "webhook_cluster_tokens_only", False) is True
