import asyncio
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs

from fastapi.encoders import jsonable_encoder
from kubernetes import client, watch


@dataclass
class Subscription:
    key: str
    stop_event: asyncio.Event
    task: asyncio.Task


class WebSocketMultiplexer:
    def __init__(self, k8s_service) -> None:
        self._subs: Dict[str, Subscription] = {}
        self._ws_keys: Dict[int, set[str]] = {}
        self._k8s = k8s_service

    def _to_iso(self, value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    def _make_key(self, ws_id: int, cluster_id: str, path: str, query: str) -> str:
        return f"{ws_id}:{cluster_id}:{path}?{query}"

    def _parse_path(self, path: str) -> Tuple[str, Optional[str]]:
        # Support paths like:
        # /api/v1/pods
        # /api/v1/namespaces/{ns}/pods
        # /api/v1/nodes
        # /api/v1/events
        # /api/v1/namespaces/{ns}/events
        parts = [p for p in path.strip("/").split("/") if p]
        if len(parts) < 2 or parts[0] != "api" or parts[1] != "v1":
            raise ValueError(f"unsupported api path: {path}")

        if len(parts) == 3:
            resource = parts[2]
            return resource, None

        if len(parts) >= 5 and parts[2] == "namespaces":
            namespace = parts[3]
            resource = parts[4]
            return resource, namespace

        raise ValueError(f"unsupported api path: {path}")

    def _parse_query(self, query: str) -> Dict[str, Any]:
        raw = parse_qs(query or "")
        params: Dict[str, Any] = {}
        for key, value in raw.items():
            if not value:
                continue
            params[key] = value[0]

        # Drop watch flag
        params.pop("watch", None)

        # Normalize common k8s query params -> python client naming
        mapped: Dict[str, Any] = {}
        key_map = {
            "resourceVersion": "resource_version",
            "resource_version": "resource_version",
            "labelSelector": "label_selector",
            "label_selector": "label_selector",
            "fieldSelector": "field_selector",
            "field_selector": "field_selector",
            "timeoutSeconds": "timeout_seconds",
            "timeout_seconds": "timeout_seconds",
            "limit": "limit",
            "continue": "_continue",
        }
        for key, val in params.items():
            mapped_key = key_map.get(key, key)
            mapped[mapped_key] = val
        return mapped

    def _node_to_info(self, node: Any) -> Dict[str, Any]:
        node_info = {
            "name": node.metadata.name,
            "status": "Ready"
            if any(c.type == "Ready" and c.status == "True" for c in node.status.conditions)
            else "NotReady",
            "roles": [],
            "age": str(datetime.now() - node.metadata.creation_timestamp.replace(tzinfo=None)),
            "version": node.status.node_info.kubelet_version,
            "internal_ip": None,
            "external_ip": None,
        }

        if node.metadata.labels:
            for label, value in node.metadata.labels.items():
                if "node-role.kubernetes.io/" in label:
                    role = label.split("/")[1]
                    if role:
                        node_info["roles"].append(role)

        if node.status.addresses:
            for addr in node.status.addresses:
                if addr.type == "InternalIP":
                    node_info["internal_ip"] = addr.address
                elif addr.type == "ExternalIP":
                    node_info["external_ip"] = addr.address

        return node_info

    def _namespace_to_info(self, ns: Any) -> Dict[str, Any]:
        created_at = None
        if ns.metadata and ns.metadata.creation_timestamp:
            created_at = self._to_iso(ns.metadata.creation_timestamp)
        return {
            "name": ns.metadata.name,
            "status": getattr(ns.status, "phase", None) if getattr(ns, "status", None) else None,
            "created_at": created_at,
            "labels": dict(ns.metadata.labels) if ns.metadata.labels else {},
            "resource_count": {},
        }

    def _event_to_info(self, event: Any) -> Dict[str, Any]:
        return {
            "type": event.type,
            "reason": event.reason,
            "message": event.message,
            "namespace": getattr(event.metadata, "namespace", None),
            "object": {
                "kind": event.involved_object.kind,
                "name": event.involved_object.name,
            },
            "first_timestamp": self._to_iso(getattr(event, "first_timestamp", None)),
            "last_timestamp": self._to_iso(getattr(event, "last_timestamp", None)),
            "event_time": self._to_iso(getattr(event, "event_time", None)),
            "count": event.count,
        }

    def _statefulset_to_info(self, sts: Any) -> Dict[str, Any]:
        desired = getattr(sts.spec, "replicas", 0) or 0
        ready = getattr(sts.status, "ready_replicas", 0) or 0
        current = getattr(sts.status, "current_replicas", 0) or 0
        updated = getattr(sts.status, "updated_replicas", 0) or 0
        available = getattr(sts.status, "available_replicas", 0) or 0

        template_spec = getattr(getattr(sts.spec, "template", None), "spec", None)
        containers = list(getattr(template_spec, "containers", None) or [])
        images = [c.image for c in containers if getattr(c, "image", None)]

        status = "Healthy"
        if desired == 0 and ready == 0:
            status = "Idle"
        elif ready != desired:
            status = "Degraded"
        if desired > 0 and ready == 0:
            status = "Unavailable"

        return {
            "name": sts.metadata.name,
            "namespace": sts.metadata.namespace,
            "replicas": desired,
            "ready_replicas": ready,
            "current_replicas": current,
            "updated_replicas": updated,
            "available_replicas": available,
            "service_name": getattr(sts.spec, "service_name", None),
            "images": images,
            "status": status,
            "created_at": self._to_iso(getattr(sts.metadata, "creation_timestamp", None)),
        }

    def _daemonset_to_info(self, ds: Any) -> Dict[str, Any]:
        desired = getattr(ds.status, "desired_number_scheduled", 0) or 0
        current = getattr(ds.status, "current_number_scheduled", 0) or 0
        ready = getattr(ds.status, "number_ready", 0) or 0
        updated = getattr(ds.status, "updated_number_scheduled", 0) or 0
        available = getattr(ds.status, "number_available", 0) or 0
        misscheduled = getattr(ds.status, "number_misscheduled", 0) or 0
        unavailable = getattr(ds.status, "number_unavailable", None)
        if unavailable is None:
            unavailable = max(desired - ready, 0)

        template_spec = getattr(getattr(ds.spec, "template", None), "spec", None)
        containers = list(getattr(template_spec, "containers", None) or [])
        images = [c.image for c in containers if getattr(c, "image", None)]
        node_selector = dict(getattr(template_spec, "node_selector", None) or {})

        status = "Healthy"
        if desired == 0 and current == 0:
            status = "Idle"
        elif ready != desired or misscheduled > 0 or unavailable > 0:
            status = "Degraded"
        if desired > 0 and ready == 0:
            status = "Unavailable"

        return {
            "name": ds.metadata.name,
            "namespace": ds.metadata.namespace,
            "desired": desired,
            "current": current,
            "ready": ready,
            "updated": updated,
            "available": available,
            "misscheduled": misscheduled,
            "unavailable": unavailable,
            "node_selector": node_selector,
            "images": images,
            "status": status,
            "created_at": self._to_iso(getattr(ds.metadata, "creation_timestamp", None)),
        }

    async def handle_message(self, websocket, msg: Dict[str, Any]) -> None:
        msg_type = (msg.get("type") or "").upper()
        if msg_type == "REQUEST":
            await self._start_watch(websocket, msg)
        elif msg_type == "CLOSE":
            await self._stop_watch(websocket, msg)

    async def _start_watch(self, websocket, msg: Dict[str, Any]) -> None:
        ws_id = id(websocket)
        cluster_id = msg.get("clusterId") or "default"
        path = msg.get("path") or ""
        query = msg.get("query") or ""
        key = self._make_key(ws_id, cluster_id, path, query)

        if key in self._subs:
            return

        stop_event = asyncio.Event()
        task = asyncio.create_task(self._run_watch(websocket, path, query, stop_event))
        self._subs[key] = Subscription(key=key, stop_event=stop_event, task=task)

        if ws_id not in self._ws_keys:
            self._ws_keys[ws_id] = set()
        self._ws_keys[ws_id].add(key)

    async def _stop_watch(self, websocket, msg: Dict[str, Any]) -> None:
        ws_id = id(websocket)
        cluster_id = msg.get("clusterId") or "default"
        path = msg.get("path") or ""
        query = msg.get("query") or ""
        key = self._make_key(ws_id, cluster_id, path, query)
        await self._stop_key(key, ws_id)

    async def stop_all_for_ws(self, websocket) -> None:
        ws_id = id(websocket)
        keys = self._ws_keys.pop(ws_id, set())
        for key in list(keys):
            await self._stop_key(key, ws_id)

    async def _stop_key(self, key: str, ws_id: int) -> None:
        sub = self._subs.pop(key, None)
        if sub:
            sub.stop_event.set()
            sub.task.cancel()
        if ws_id in self._ws_keys:
            self._ws_keys[ws_id].discard(key)
            if not self._ws_keys[ws_id]:
                self._ws_keys.pop(ws_id, None)

    async def _run_watch(self, websocket, path: str, query: str, stop_event: asyncio.Event) -> None:
        try:
            async for event in self._watch_stream(path, query, stop_event):
                payload = {
                    "type": "DATA",
                    "path": path,
                    "query": query,
                    "data": event,
                }
                await websocket.send_json(jsonable_encoder(payload))
        except asyncio.CancelledError:
            return
        except Exception as e:
            payload = {
                "type": "ERROR",
                "path": path,
                "query": query,
                "error": {"message": str(e)},
            }
            await websocket.send_json(jsonable_encoder(payload))

    async def _watch_stream(self, path: str, query: str, stop_event: asyncio.Event):
        resource, namespace = self._parse_path(path)
        params = self._parse_query(query)
        core = self._k8s.v1
        apps = self._k8s.apps_v1
        w = watch.Watch()

        last_resource_version = params.get("resource_version")
        timeout_seconds = int(params.get("timeout_seconds") or 30)
        params = {k: v for k, v in params.items() if k not in {"resource_version", "timeout_seconds"}}

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def worker():
            nonlocal last_resource_version
            try:
                while not stop_event.is_set():
                    stream_params = {
                        **params,
                        "resource_version": last_resource_version,
                        "timeout_seconds": timeout_seconds,
                    }

                    if resource == "pods":
                        if namespace:
                            stream = w.stream(core.list_namespaced_pod, namespace, **stream_params)
                        else:
                            stream = w.stream(core.list_pod_for_all_namespaces, **stream_params)
                    elif resource == "nodes":
                        stream = w.stream(core.list_node, **stream_params)
                    elif resource == "namespaces":
                        stream = w.stream(core.list_namespace, **stream_params)
                    elif resource == "events":
                        if namespace:
                            stream = w.stream(core.list_namespaced_event, namespace, **stream_params)
                        else:
                            stream = w.stream(core.list_event_for_all_namespaces, **stream_params)
                    elif resource == "statefulsets":
                        if namespace:
                            stream = w.stream(apps.list_namespaced_stateful_set, namespace, **stream_params)
                        else:
                            stream = w.stream(apps.list_stateful_set_for_all_namespaces, **stream_params)
                    elif resource == "daemonsets":
                        if namespace:
                            stream = w.stream(apps.list_namespaced_daemon_set, namespace, **stream_params)
                        else:
                            stream = w.stream(apps.list_daemon_set_for_all_namespaces, **stream_params)
                    else:
                        raise ValueError(f"unsupported watch resource: {resource}")

                    for event in stream:
                        if stop_event.is_set():
                            w.stop()
                            break
                        obj = event.get("object")
                        if obj is not None and hasattr(obj, "metadata"):
                            last_resource_version = getattr(obj.metadata, "resource_version", last_resource_version)

                        if resource == "pods" and obj is not None:
                            obj = self._k8s._pod_to_info(obj).dict()
                        elif resource == "nodes" and obj is not None:
                            obj = self._node_to_info(obj)
                        elif resource == "namespaces" and obj is not None:
                            obj = self._namespace_to_info(obj)
                        elif resource == "events" and obj is not None:
                            obj = self._event_to_info(obj)
                        elif resource == "statefulsets" and obj is not None:
                            obj = self._statefulset_to_info(obj)
                        elif resource == "daemonsets" and obj is not None:
                            obj = self._daemonset_to_info(obj)

                        loop.call_soon_threadsafe(
                            queue.put_nowait, {"type": event.get("type"), "object": obj}
                        )

                    if stop_event.is_set():
                        break
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        while True:
            if stop_event.is_set():
                break
            item = await queue.get()
            if item is None:
                break
            yield {"type": item.get("type"), "object": item.get("object")}
