import json
import os
import time
from datetime import datetime
from typing import Any, Dict, Optional

import psycopg2
from kubernetes import client, config, watch


GROUP = os.getenv("MODEL_CONFIG_GROUP", "ai.kube-assistant.io")
VERSION = os.getenv("MODEL_CONFIG_VERSION", "v1alpha1")
PLURAL = os.getenv("MODEL_CONFIG_PLURAL", "modelconfigs")
NAMESPACE = os.getenv("WATCH_NAMESPACE", "kube-assistant")

DATABASE_URL = os.getenv("DATABASE_URL", "")


def _normalize_db_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg://"):
        return url.replace("postgresql+asyncpg://", "postgresql://", 1)
    return url


def _get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg2.connect(_normalize_db_url(DATABASE_URL))


def ensure_table():
    ddl = """
    CREATE TABLE IF NOT EXISTS model_configs (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT,
      api_key_secret_name TEXT,
      api_key_secret_key TEXT,
      api_key_env TEXT,
      extra_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      tls_verify BOOLEAN NOT NULL DEFAULT TRUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(ddl)
        conn.commit()


def _parse_spec(name: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    provider = spec.get("provider", "openai")
    model = spec.get("model")
    if not model:
        raise ValueError("spec.model is required")

    base_url = spec.get("baseURL") or spec.get("base_url")

    secret_ref = spec.get("apiKeySecretRef") or {}
    api_key_secret_name = secret_ref.get("name")
    api_key_secret_key = secret_ref.get("key")

    api_key_env = spec.get("apiKeyEnv")
    extra_headers = spec.get("extraHeaders") or {}
    tls_verify = spec.get("tlsVerify", True)
    enabled = spec.get("enabled", True)
    is_default = spec.get("isDefault", False)

    return {
        "name": name,
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "api_key_secret_name": api_key_secret_name,
        "api_key_secret_key": api_key_secret_key,
        "api_key_env": api_key_env,
        "extra_headers": extra_headers,
        "tls_verify": bool(tls_verify),
        "enabled": bool(enabled),
        "is_default": bool(is_default),
    }


def upsert_config(data: Dict[str, Any]) -> int:
    sql = """
    INSERT INTO model_configs (
      name, provider, model, base_url,
      api_key_secret_name, api_key_secret_key, api_key_env,
      extra_headers, tls_verify, enabled, is_default,
      created_at, updated_at
    )
    VALUES (
      %(name)s, %(provider)s, %(model)s, %(base_url)s,
      %(api_key_secret_name)s, %(api_key_secret_key)s, %(api_key_env)s,
      %(extra_headers)s::jsonb, %(tls_verify)s, %(enabled)s, %(is_default)s,
      NOW(), NOW()
    )
    ON CONFLICT (name) DO UPDATE SET
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      base_url = EXCLUDED.base_url,
      api_key_secret_name = EXCLUDED.api_key_secret_name,
      api_key_secret_key = EXCLUDED.api_key_secret_key,
      api_key_env = EXCLUDED.api_key_env,
      extra_headers = EXCLUDED.extra_headers,
      tls_verify = EXCLUDED.tls_verify,
      enabled = EXCLUDED.enabled,
      is_default = EXCLUDED.is_default,
      updated_at = NOW()
    RETURNING id;
    """
    with _get_conn() as conn:
        with conn.cursor() as cur:
            if data.get("is_default"):
                cur.execute(
                    "UPDATE model_configs SET is_default = FALSE WHERE name <> %s",
                    (data["name"],),
                )
            cur.execute(sql, {
                **data,
                "extra_headers": json.dumps(data.get("extra_headers") or {}),
            })
            row = cur.fetchone()
        conn.commit()
    return int(row[0]) if row else 0


def delete_config(name: str) -> None:
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM model_configs WHERE name = %s", (name,))
        conn.commit()


def patch_status(api: client.CustomObjectsApi, name: str, namespace: str, status: Dict[str, Any]):
    body = {"status": status}
    api.patch_namespaced_custom_object_status(
        GROUP, VERSION, namespace, PLURAL, name, body
    )


def handle_event(api: client.CustomObjectsApi, event_type: str, obj: Dict[str, Any]):
    meta = obj.get("metadata") or {}
    spec = obj.get("spec") or {}
    name = meta.get("name")
    namespace = meta.get("namespace") or NAMESPACE
    if not name:
        return

    try:
        if event_type in ("ADDED", "MODIFIED"):
            data = _parse_spec(name, spec)
            db_id = upsert_config(data)
            patch_status(api, name, namespace, {
                "synced": True,
                "dbId": db_id,
                "lastSyncTime": datetime.utcnow().isoformat() + "Z",
                "message": "Synced to DB",
            })
        elif event_type == "DELETED":
            delete_config(name)
    except Exception as e:
        try:
            patch_status(api, name, namespace, {
                "synced": False,
                "lastSyncTime": datetime.utcnow().isoformat() + "Z",
                "message": f"Sync error: {str(e)}",
            })
        except Exception:
            pass
        raise


def main():
    print("[model-config-controller] starting...", flush=True)
    ensure_table()

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()

    api = client.CustomObjectsApi()
    w = watch.Watch()
    resource_version: Optional[str] = None

    while True:
        try:
            stream = w.stream(
                api.list_namespaced_custom_object,
                GROUP,
                VERSION,
                NAMESPACE,
                PLURAL,
                resource_version=resource_version,
                timeout_seconds=60,
            )
            for event in stream:
                obj = event.get("object") or {}
                event_type = event.get("type") or ""
                resource_version = (obj.get("metadata") or {}).get("resourceVersion") or resource_version
                handle_event(api, event_type, obj)
        except Exception as e:
            print(f"[model-config-controller] watch error: {e}", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
