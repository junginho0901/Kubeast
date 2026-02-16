import base64
import hashlib
import json
import os
import time
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

import psycopg2
from kubernetes import client, config, watch


GROUP = os.getenv("MODEL_CONFIG_GROUP", "ai.kube-assistant.io")
VERSION = os.getenv("MODEL_CONFIG_VERSION", "v1alpha1")
PLURAL = os.getenv("MODEL_CONFIG_PLURAL", "modelconfigs")
NAMESPACE = os.getenv("WATCH_NAMESPACE", "kube-assistant")

DATABASE_URL = os.getenv("DATABASE_URL", "")


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


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


def _provider_block(spec: Dict[str, Any], provider_norm: str) -> Dict[str, Any]:
    if provider_norm in ("openai", "open-ai", "open_ai"):
        return spec.get("openAI") or spec.get("openai") or {}
    if provider_norm in ("anthropic",):
        return spec.get("anthropic") or {}
    if provider_norm in ("azureopenai", "azure-openai", "azure_openai"):
        return spec.get("azureOpenAI") or spec.get("azure_openai") or {}
    if provider_norm in ("gemini",):
        return spec.get("gemini") or {}
    if provider_norm in ("geminivertexai", "gemini-vertexai", "gemini_vertexai"):
        return spec.get("geminiVertexAI") or spec.get("gemini_vertex_ai") or {}
    if provider_norm in ("anthropicvertexai", "anthropic-vertexai", "anthropic_vertexai"):
        return spec.get("anthropicVertexAI") or spec.get("anthropic_vertex_ai") or {}
    if provider_norm in ("ollama",):
        return spec.get("ollama") or {}
    return {}


def _resolve_base_url(spec: Dict[str, Any], provider_norm: str) -> Optional[str]:
    base_url = spec.get("baseURL") or spec.get("base_url")
    if base_url:
        return base_url

    block = _provider_block(spec, provider_norm)
    if not block:
        return None

    if provider_norm in ("openai", "open-ai", "open_ai"):
        return block.get("baseUrl") or block.get("baseURL")
    if provider_norm in ("anthropic",):
        return block.get("baseUrl") or block.get("baseURL")
    if provider_norm in ("azureopenai", "azure-openai", "azure_openai"):
        return block.get("azureEndpoint") or block.get("endpoint")
    if provider_norm in ("ollama",):
        return block.get("host")
    return None


def _parse_spec(name: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    provider = spec.get("provider", "openai")
    provider_norm = str(provider).lower()
    model = spec.get("model")
    if not model:
        raise ValueError("spec.model is required")

    base_url = _resolve_base_url(spec, provider_norm)

    secret_ref = spec.get("apiKeySecretRef") or {}
    if isinstance(secret_ref, str):
        api_key_secret_name = secret_ref
        api_key_secret_key = spec.get("apiKeySecretKey") or spec.get("apiKeySecretKey".lower())
    else:
        api_key_secret_name = secret_ref.get("name")
        api_key_secret_key = secret_ref.get("key")

    api_key_env = spec.get("apiKeyEnv")
    extra_headers = spec.get("extraHeaders") or spec.get("defaultHeaders") or {}
    if not isinstance(extra_headers, dict):
        extra_headers = {}
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


def _get_secret_hash(
    core_api: client.CoreV1Api,
    namespace: str,
    secret_name: Optional[str],
    secret_key: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    if not secret_name or not secret_key:
        return None, None
    try:
        secret = core_api.read_namespaced_secret(secret_name, namespace)
    except client.exceptions.ApiException as e:
        if e.status == 404:
            return None, f"Secret {secret_name} not found"
        return None, f"Secret read error: {str(e)}"

    data = secret.data or {}
    if secret_key not in data:
        return None, f"Secret key {secret_key} not found in {secret_name}"

    raw_value = data.get(secret_key)
    if raw_value is None:
        return None, f"Secret key {secret_key} is empty in {secret_name}"

    try:
        decoded = base64.b64decode(raw_value)
    except Exception:
        decoded = str(raw_value).encode()

    return hashlib.sha256(decoded).hexdigest(), None


def _build_conditions(
    synced_ok: bool,
    secret_state: str,
    observed_generation: Optional[int],
    sync_message: str,
    secret_message: str,
) -> list:
    now = _now_iso()
    conditions = [
        {
            "type": "Synced",
            "status": "True" if synced_ok else "False",
            "lastTransitionTime": now,
            "reason": "Synced" if synced_ok else "SyncError",
            "message": sync_message,
            "observedGeneration": observed_generation,
        },
        {
            "type": "SecretReady",
            "status": secret_state,
            "lastTransitionTime": now,
            "reason": "SecretResolved" if secret_state == "True" else ("SecretMissing" if secret_state == "False" else "Unknown"),
            "message": secret_message,
            "observedGeneration": observed_generation,
        },
    ]
    return conditions


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


def handle_event(api: client.CustomObjectsApi, core_api: client.CoreV1Api, event_type: str, obj: Dict[str, Any]):
    meta = obj.get("metadata") or {}
    spec = obj.get("spec") or {}
    name = meta.get("name")
    namespace = meta.get("namespace") or NAMESPACE
    generation = meta.get("generation")
    if not name:
        return

    try:
        if event_type in ("ADDED", "MODIFIED"):
            data = _parse_spec(name, spec)
            db_id = upsert_config(data)
            secret_hash, secret_error = _get_secret_hash(
                core_api,
                namespace,
                data.get("api_key_secret_name"),
                data.get("api_key_secret_key"),
            )
            secret_required = bool(data.get("api_key_secret_name") and data.get("api_key_secret_key"))
            secret_state = "True" if (not secret_required or secret_error is None) else "False"
            secret_message = "Secret not required" if not secret_required else (secret_error or "Secret resolved")
            sync_message = "Synced to DB"
            patch_status(api, name, namespace, {
                "synced": True,
                "dbId": db_id,
                "lastSyncTime": _now_iso(),
                "message": sync_message if secret_state == "True" else f"{sync_message}; {secret_message}",
                "observedGeneration": generation,
                "secretHash": secret_hash,
                "conditions": _build_conditions(
                    synced_ok=True,
                    secret_state=secret_state,
                    observed_generation=generation,
                    sync_message=sync_message,
                    secret_message=secret_message,
                ),
            })
        elif event_type == "DELETED":
            delete_config(name)
    except Exception as e:
        try:
            err_message = f"Sync error: {str(e)}"
            patch_status(api, name, namespace, {
                "synced": False,
                "lastSyncTime": _now_iso(),
                "message": err_message,
                "observedGeneration": generation,
                "conditions": _build_conditions(
                    synced_ok=False,
                    secret_state="Unknown",
                    observed_generation=generation,
                    sync_message=err_message,
                    secret_message="Secret not evaluated due to sync error",
                ),
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
    core_api = client.CoreV1Api()
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
                handle_event(api, core_api, event_type, obj)
        except Exception as e:
            print(f"[model-config-controller] watch error: {e}", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
