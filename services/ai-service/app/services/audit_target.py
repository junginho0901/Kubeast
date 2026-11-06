"""The audit target of an AI tool call (MCP, chat, approved write, investigation).

A tool that names its object (resource_type, resource_name, namespace) is
recorded as that object. A tool that takes a manifest (create, apply, diff)
names nothing in its arguments, so the target comes from the manifest: its
kind, metadata.namespace and metadata.name, as Kubernetes' own audit records
the object (objectRef) rather than the request.
"""

import copy
import json
from dataclasses import replace
from typing import Any, NamedTuple, Optional

import yaml

from app.services import redact
from app.services.tool_whitelists import WRITE_TOOL_NAMES

MAX_OBJECTS = 50
MAX_MANIFEST_CHARS = 1 << 20
EXEC_TOOL = "k8s_execute_command"
MAX_COMMAND_CHARS = 1000
# The rules read this much of a command: enough for a private key that starts inside what is kept, bounded for a long one.
MAX_COMMAND_READ_CHARS = 8 * MAX_COMMAND_CHARS
MAX_PREVIEW_CHARS = 500
MAX_SHORT_CHARS = 100
# Past this a text is not read for its preview; the row keeps its length.
MAX_READ_CHARS = 1 << 18


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


def _row_options() -> redact.Options:
    # REDACTION_* choose what reaches the model. A row outlives that choice and is copied to the sinks.
    return replace(redact.from_env(), enabled=True, disabled=set())


def _argv(value: Any) -> list[str]:
    """A command as tool-server's argStringSlice reads it, so the row says what ran."""
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        parts = raw.split(",")
        return raw.split() if len(parts) == 1 else [p.strip() for p in parts if p.strip()]
    if isinstance(value, list):
        return [s for s in (str(item).strip() for item in value if item is not None) if s]
    return []


def _first_chars(words: list[str], limit: int) -> list[str]:
    kept: list[str] = []
    for word in words:
        if limit <= 0:
            break
        kept.append(word[:limit])
        limit -= len(word)
    return kept


def _command_fields(args: dict, opts: redact.Options) -> dict[str, Any]:
    argv = _argv(args.get("command")) or _argv(args.get("cmd"))
    length = sum(len(a) for a in argv)
    kept: list[str] = []
    left = MAX_COMMAND_CHARS
    truncated = length > MAX_COMMAND_READ_CHARS
    for word in redact.redact_command(_first_chars(argv, MAX_COMMAND_READ_CHARS), opts):
        if left <= 0:
            truncated = True
            break
        kept.append(word[:left])
        truncated = truncated or len(word) > left
        left -= len(word)
    fields: dict[str, Any] = {"command": kept, "command_len": length}
    if truncated:
        fields["command_truncated"] = True
    return fields


class _NoAliases(yaml.SafeLoader):
    """Aliases are refused: walking a document that refers to itself over and over takes exponential time."""

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise yaml.YAMLError("aliases are not read")
        return super().compose_node(parent, index)


def _documents(value: Any) -> Optional[list]:
    """A patch or manifest as data, or None when it cannot be read safely."""
    if not isinstance(value, str):
        return [copy.deepcopy(value)]
    if len(value) > MAX_READ_CHARS:
        return None
    try:
        return list(yaml.load_all(value, Loader=_NoAliases))
    except yaml.YAMLError:
        return None


def _is_secret_path(path: str) -> bool:
    segments = path.split("/")
    return any(s in ("data", "stringData", "env") for s in segments) or redact.word_key_is_sensitive(segments[-1])


def _mask_shapes(value: Any, opts: redact.Options) -> Any:
    """The shapes the key-name rule cannot read: a name next to its value, a JSON patch's path and value, a list of
    arguments whose credential may be the next item."""
    if isinstance(value, dict):
        name, path = value.get("name"), value.get("path")
        for key, item in value.items():
            value[key] = _mask_shapes(item, opts)
        if isinstance(name, str) and redact.word_key_is_sensitive(name) and isinstance(value.get("value"), str):
            value["value"] = f"<REDACTED:{name}>"
        if "op" in value and isinstance(path, str) and _is_secret_path(path) and "value" in value:
            value["value"] = "<REDACTED:value>"
        return value
    if isinstance(value, list):
        if value and all(isinstance(item, str) for item in value):
            return redact.redact_command(value, opts)
        return [_mask_shapes(item, opts) for item in value]
    return value


def _preview_fields(name: str, value: Any, opts: redact.Options, *, secret: bool = False) -> dict[str, Any]:
    """The length of a patch or manifest and its first characters, read as data and masked. Text that cannot be read
    keeps its length only: a row is sealed and never changes, so what it might hold is left out."""
    fields: dict[str, Any] = {}
    try:
        length = len(value) if isinstance(value, str) else len(json.dumps(value, ensure_ascii=False, default=str))
        fields[f"{name}_len"] = length
        if secret or length > MAX_READ_CHARS:
            return fields
        docs = _documents(value)
        if docs is None:
            return fields
        masked = [_mask_shapes(redact.redact_object(doc, opts)[0], opts) for doc in docs]
        text = yaml.safe_dump_all(masked, sort_keys=True, allow_unicode=True, default_flow_style=False)
        text = redact.redact_words(redact.redact_text(text, opts)[0])
    except (yaml.YAMLError, RecursionError, ValueError, TypeError):
        return fields
    fields[f"{name}_preview"] = text[:MAX_PREVIEW_CHARS]
    return fields


def _names_secret(resource_type: Any) -> bool:
    return any(part.strip().split(".")[0].lower() in ("secret", "secrets") for part in str(resource_type or "").split(","))


def _short(value: Any, opts: redact.Options) -> Any:
    if isinstance(value, str):
        return redact.redact_words(redact.redact_text(value[:MAX_COMMAND_CHARS], opts)[0])[:MAX_SHORT_CHARS]
    return value if isinstance(value, (bool, int, float)) else _short(str(value), opts)


def write_tool_input(tool: str, args: dict) -> dict[str, Any]:
    """What a write tool was asked to do, for its audit row: a command, or a patch's and manifest's length and masked
    start. No hash: a value that can be guessed could be checked against one. A read tool's row has none of this."""
    if tool not in WRITE_TOOL_NAMES or not isinstance(args, dict):
        return {}
    opts = _row_options()
    secret = _names_secret(args.get("resource_type"))
    fields: dict[str, Any] = {}
    if tool == EXEC_TOOL:
        fields.update(_command_fields(args, opts))
    if tool == "k8s_patch_resource" and args.get("patch") is not None:
        fields.update(_preview_fields("patch", args["patch"], opts, secret=secret))
    if tool in ("k8s_apply_manifest", "k8s_create_resource"):
        manifest = next((args[k] for k in ("yaml_content", "resource_manifest", "manifest") if args.get(k)), None)
        if manifest is not None:
            fields.update(_preview_fields("manifest", manifest, opts))
    for name in ("annotations", "labels", "keys"):
        if args.get(name):
            fields.update(_preview_fields(name, args[name], opts, secret=secret and name == "annotations"))
    for arg, field in (("container", "container"), ("patch_type", "patch_type"), ("action", "rollout_action"), ("revision", "revision"),
                       ("replicas", "replicas"), ("all", "all"), ("force", "force"), ("grace_period", "grace_period")):
        if args.get(arg) is not None:
            fields[field] = _short(args[arg], opts)
    return fields


def pod_exec_row(args: dict, tool_input: dict[str, Any], **after: Any) -> dict[str, Any]:
    """The k8s.pod.exec row of an exec through an AI tool, the row the terminal writes, so a search or a sink filter on
    that action finds both. There is no recording: it is one command and its result. A call without a namespace runs in
    default (tool-server handleExecuteCommand)."""
    return {
        "action": "k8s.pod.exec",
        "target_type": "pod",
        "target_id": args.get("pod_name"),
        "namespace": args.get("namespace") or "default",
        "after": {"tool": EXEC_TOOL, **tool_input, **after},
    }
