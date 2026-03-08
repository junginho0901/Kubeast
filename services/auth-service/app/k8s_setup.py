from datetime import datetime, timedelta
from typing import Tuple

from kubernetes import client, config
from kubernetes.client.rest import ApiException
from urllib.request import Request, urlopen
import json


class KubeconfigValidationError(Exception):
    pass


def _load_kube_config() -> None:
    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()


def _get_clients() -> Tuple[client.CoreV1Api, client.AppsV1Api]:
    _load_kube_config()
    return client.CoreV1Api(), client.AppsV1Api()


def upsert_kubeconfig_secret(
    *,
    namespace: str,
    name: str,
    kubeconfig_text: str,
) -> None:
    v1, _ = _get_clients()
    body = client.V1Secret(
        metadata=client.V1ObjectMeta(name=name, namespace=namespace),
        type="Opaque",
        string_data={"kubeconfig.yaml": kubeconfig_text or ""},
    )

    try:
        v1.read_namespaced_secret(name=name, namespace=namespace)
        v1.replace_namespaced_secret(name=name, namespace=namespace, body=body)
    except ApiException as e:
        if e.status == 404:
            v1.create_namespaced_secret(namespace=namespace, body=body)
        else:
            raise


def patch_configmap(
    *,
    namespace: str,
    name: str,
    data: dict,
) -> None:
    v1, _ = _get_clients()
    v1.patch_namespaced_config_map(name=name, namespace=namespace, body={"data": data})


def restart_deployment(*, namespace: str, name: str) -> None:
    _, apps = _get_clients()
    patch = {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": datetime.utcnow().isoformat()
                    }
                }
            }
        }
    }
    apps.patch_namespaced_deployment(name=name, namespace=namespace, body=patch)

def _parse_restarted_at(value: str) -> datetime | None:
    if not value:
        return None
    try:
        # restart_deployment uses naive UTC ISO format
        return datetime.fromisoformat(value)
    except Exception:
        return None

def _is_pod_ready(pod: client.V1Pod) -> bool:
    if pod is None or pod.metadata is None or pod.status is None:
        return False
    if pod.metadata.deletion_timestamp is not None:
        return False
    conditions = pod.status.conditions or []
    for cond in conditions:
        if cond.type == "Ready" and str(cond.status).lower() == "true":
            return True
    return False


def validate_kubeconfig_connection(*, kubeconfig: dict, timeout: int = 5) -> None:
    api_client = config.new_client_from_config_dict(kubeconfig)
    try:
        try:
            data, status, _ = api_client.call_api(
                "/healthz",
                "GET",
                response_type="str",
                _return_http_data_only=False,
                _request_timeout=timeout,
            )
        except ApiException as e:
            raise KubeconfigValidationError(f"{e.status} {e.reason}") from e
        except Exception as e:
            raise KubeconfigValidationError(str(e)) from e
    finally:
        api_client.close()

    if status < 200 or status >= 300:
        raise KubeconfigValidationError(f"Health check failed with status {status}")

    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8", errors="ignore")
    if isinstance(data, str) and data.strip().lower() not in {"ok", "healthy"}:
        # Some apiservers return plain "ok" for /healthz.
        # We accept any 2xx, but also guard against unexpected content.
        snippet = data.strip()[:200]
        raise KubeconfigValidationError(f"Health check did not return ok: {snippet}")


def check_k8s_service_health(*, url: str = "http://k8s-service:8002/health", timeout: int = 2) -> dict:
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as response:
            raw = response.read()
        payload = json.loads(raw.decode("utf-8"))
        if isinstance(payload, dict):
            return payload
    except Exception:
        return {}
    return {}


def check_rollout_status(*, namespace: str, deployment_names: list[str]) -> dict:
    """
    Check rollout status of specified deployments.
    Returns dict with overall 'ready' flag and per-deployment status.
    A deployment is fully rolled out when:
      - updatedReplicas == replicas
      - readyReplicas == replicas
      - availableReplicas == replicas
      - observedGeneration >= metadata.generation
    """
    _, apps = _get_clients()
    results = {}
    all_ready = True

    for dep_name in deployment_names:
        try:
            dep = apps.read_namespaced_deployment(name=dep_name, namespace=namespace)
            spec_replicas = dep.spec.replicas or 1
            status = dep.status
            updated = status.updated_replicas or 0
            ready = status.ready_replicas or 0
            available = status.available_replicas or 0
            generation = dep.metadata.generation or 0
            observed = status.observed_generation or 0

            is_ready = (
                observed >= generation
                and updated >= spec_replicas
                and ready >= spec_replicas
                and available >= spec_replicas
            )

            # Strict mode: ensure pods are recreated after restart timestamp (if present)
            restart_at = None
            try:
                annotations = (dep.spec.template.metadata.annotations or {}) if dep.spec and dep.spec.template and dep.spec.template.metadata else {}
                restart_at = _parse_restarted_at(annotations.get("kubectl.kubernetes.io/restartedAt", ""))
            except Exception:
                restart_at = None

            if is_ready and restart_at:
                v1, _ = _get_clients()
                selector = dep.spec.selector.match_labels or {}
                label_selector = ",".join([f"{k}={v}" for k, v in selector.items()])
                pods = v1.list_namespaced_pod(namespace=namespace, label_selector=label_selector).items
                # Allow a small skew for timestamp precision
                cutoff = restart_at - timedelta(seconds=5)
                ready_pods = [p for p in pods if _is_pod_ready(p)]
                # If replicas=0, skip pod-time check.
                if spec_replicas > 0:
                    if len(ready_pods) < spec_replicas:
                        is_ready = False
                    else:
                        for p in ready_pods[:spec_replicas]:
                            created = p.metadata.creation_timestamp
                            created_naive = created.replace(tzinfo=None) if created else None
                            if not created_naive or created_naive < cutoff:
                                is_ready = False
                                break

            results[dep_name] = {
                "ready": is_ready,
                "replicas": spec_replicas,
                "updated": updated,
                "ready_replicas": ready,
                "available": available,
                "restart_at": restart_at.isoformat() if restart_at else None,
            }
            if not is_ready:
                all_ready = False
        except Exception as e:
            results[dep_name] = {"ready": False, "error": str(e)[:100]}
            all_ready = False

    return {"ready": all_ready, "deployments": results}
