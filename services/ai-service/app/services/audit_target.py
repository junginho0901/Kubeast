"""The audit target of an AI tool call (MCP, chat, approved write, investigation).

A tool that names its object (resource_type, resource_name, namespace) is
recorded as that object. A tool that takes a manifest (create, apply, diff)
names nothing in its arguments, so the target comes from the manifest: its
kind, metadata.namespace and metadata.name, as Kubernetes' own audit records
the object (objectRef) rather than the request.
"""

from typing import Any, NamedTuple, Optional

import yaml

MAX_OBJECTS = 50
MAX_MANIFEST_CHARS = 1 << 20


class ToolTarget(NamedTuple):
    type: str
    id: str
    namespace: Optional[str]
    # "Kind namespace/name" per object of a manifest, else None
    objects: Optional[list[str]]


def _manifest_objects(args: dict) -> list[dict]:
    manifest = args.get("resource_manifest")
    if isinstance(manifest, dict):
        docs: list[Any] = [manifest]
    else:
        text = next((v for v in (args.get("yaml_content"), args.get("manifest"), manifest) if isinstance(v, str) and v.strip()), "")
        if not text or len(text) > MAX_MANIFEST_CHARS:
            return []
        try:
            docs = list(yaml.safe_load_all(text))
        except yaml.YAMLError:
            return []
    objects: list[dict] = []
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        items = doc.get("items") if str(doc.get("kind", "")).endswith("List") else None
        objects.extend(o for o in (items if isinstance(items, list) else [doc]) if isinstance(o, dict) and isinstance(o.get("kind"), str))
    return objects


def tool_target(tool: str, args: dict) -> ToolTarget:
    namespace = args.get("namespace") if isinstance(args.get("namespace"), str) and args.get("namespace") else None
    named = args.get("resource_name") or args.get("name") or args.get("pod_name")
    objects = [] if named else _manifest_objects(args)
    if not objects:
        return ToolTarget(args.get("resource_type") or "tool", named or tool, namespace, None)

    refs: list[str] = []
    namespaces: set[str] = set()
    for obj in objects:
        meta = obj.get("metadata") if isinstance(obj.get("metadata"), dict) else {}
        ns = meta.get("namespace") if isinstance(meta.get("namespace"), str) and meta.get("namespace") else namespace
        namespaces.add(ns or "")
        name = meta.get("name") or meta.get("generateName") or "?"
        refs.append(f"{obj['kind']} {ns}/{name}" if ns else f"{obj['kind']} {name}")
    kinds = {obj["kind"] for obj in objects}
    if len(objects) == 1:
        meta = objects[0].get("metadata") if isinstance(objects[0].get("metadata"), dict) else {}
        target_id = str(meta.get("name") or meta.get("generateName") or tool)
    else:
        target_id = f"{len(objects)} objects"
    return ToolTarget(
        kinds.pop() if len(kinds) == 1 else "manifest",
        target_id,
        (namespaces.pop() or None) if len(namespaces) == 1 else None,
        refs[:MAX_OBJECTS],
    )
