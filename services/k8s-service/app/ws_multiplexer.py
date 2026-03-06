import asyncio
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs

from kubernetes import client, watch


@dataclass
class Subscription:
    key: str
    stop_event: asyncio.Event
    task: asyncio.Task


class WebSocketMultiplexer:
    def __init__(self) -> None:
        self._subs: Dict[str, Subscription] = {}
        self._ws_keys: Dict[int, set[str]] = {}

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
                await websocket.send_json(event)
        except asyncio.CancelledError:
            return
        except Exception as e:
            await websocket.send_json({"type": "ERROR", "object": {"message": str(e)}})

    async def _watch_stream(self, path: str, query: str, stop_event: asyncio.Event):
        resource, namespace = self._parse_path(path)
        params = self._parse_query(query)
        core = client.CoreV1Api()
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
                    elif resource == "events":
                        if namespace:
                            stream = w.stream(core.list_namespaced_event, namespace, **stream_params)
                        else:
                            stream = w.stream(core.list_event_for_all_namespaces, **stream_params)
                    else:
                        raise ValueError(f"unsupported watch resource: {resource}")

                    for event in stream:
                        if stop_event.is_set():
                            w.stop()
                            break
                        obj = event.get("object")
                        if obj is not None and hasattr(obj, "metadata"):
                            last_resource_version = getattr(obj.metadata, "resource_version", last_resource_version)
                        loop.call_soon_threadsafe(queue.put_nowait, event)

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
            obj = item.get("object")
            if obj is not None and hasattr(obj, "to_dict"):
                obj = obj.to_dict()
            yield {"type": item.get("type"), "object": obj}
