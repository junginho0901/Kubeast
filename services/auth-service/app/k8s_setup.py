from datetime import datetime
from typing import Optional, Tuple

from kubernetes import client, config
from kubernetes.client.rest import ApiException


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
