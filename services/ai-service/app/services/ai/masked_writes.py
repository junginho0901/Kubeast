"""What a tool's answer holds in place of a value is not that value, and the assistant never reads the value, whoever
asks. A write holding it would store those letters over the real one, so the chat stops it before the approval card and
says why. tool-server refuses the same calls before kubectl (masked_writes.go); both read
tests/fixtures/masked_write_cases.json."""
import base64
import binascii
import json
import re
from typing import Any, List, Optional

from app.services.tool_whitelists import WRITE_TOOL_NAMES

_SHOWN = 5
# A masked value (its name may hold spaces: a key's name, k8s_diff's "new value") and a personal-data address (REDACTION_PII).
_PLACEHOLDER = re.compile(r"""(?:<|\\u003[cC])(REDACTED:[^<>"'\\\r\n]*|EMAIL_[0-9]+)(?:>|\\u003[eE])""")
_ENCODED_TOKEN = re.compile(r"[A-Za-z0-9+/]{16,}={0,2}")
# k8s-service's Secret mask means nothing outside a Secret, where three stars may be a value. A SecretList's items without a
# kind of their own are Secrets to kubectl.
_SECRET_KIND_YAML = re.compile(r"""^[ \t]*(?:-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret(?:List)?["']?[ \t]*\r?$""", re.MULTILINE)
_SECRET_KIND_JSON = re.compile(r'"kind"\s*:\s*"Secret(?:List)?"')
_MASK_YAML = re.compile(r"""^[ \t]*(?:-[ \t]+)?["']?[A-Za-z0-9._/\-]+["']?[ \t]*:[ \t]*["']?\*\*\*["']?[ \t]*\r?$""", re.MULTILINE)
_MASK_JSON = re.compile(r'"[A-Za-z0-9._/\-]+"\s*:\s*"\*\*\*"')
# base64 of the mask, without and with the quotes an older YAML window saved it with
_MASK_ENCODED = re.compile(r"""(?:^|[\s"':,{\[])(?:Kioq|JyoqKic=|IioqKiI=)(?:$|[\s"',}\]])""")


def _names_secrets(resource_type: Any) -> bool:
    """A kubectl resource argument listing core Secrets, as tool-server's namesSecrets reads it."""
    if not isinstance(resource_type, str):
        return False
    for one in resource_type.split(","):
        name, _, rest = one.strip().lower().partition(".")
        if name in ("secret", "secrets") and ("." not in rest or rest == "v1.core"):
            return True
    return False


def _argument_texts(args: dict) -> List[str]:
    texts = []
    for key, value in args.items():
        if key == "resource_type":
            continue
        if isinstance(value, str):
            texts.append(value)
            continue
        try:
            texts.append(json.dumps(value, ensure_ascii=False))
        except (TypeError, ValueError):
            pass
    return texts


def _placeholders(args: dict) -> List[str]:
    names_secret = _names_secrets(args.get("resource_type"))
    found: List[str] = []

    def add(word: str) -> None:
        if word not in found:
            found.append(word)

    for text in _argument_texts(args):
        for word in _PLACEHOLDER.findall(text):
            add(f"<{word}>")
        for token in _ENCODED_TOKEN.findall(text):
            try:
                decoded = base64.b64decode(token, validate=True).decode("utf-8", "ignore")
            except (binascii.Error, ValueError):
                continue
            for word in _PLACEHOLDER.findall(decoded):
                add(f"<{word}>")
        for document in text.split("\n---"):
            if not (names_secret or _SECRET_KIND_YAML.search(document) or _SECRET_KIND_JSON.search(document)):
                continue
            if _MASK_YAML.search(document) or _MASK_JSON.search(document) or _MASK_ENCODED.search(document):
                add("***")
    return found


def masked_write_refusal(tool: str, args: Any) -> Optional[str]:
    """Why this write cannot run, for the model to say; None for a call holding no placeholder."""
    if tool not in WRITE_TOOL_NAMES or not isinstance(args, dict):
        return None
    found = _placeholders(args)
    if not found:
        return None
    return (f"This write holds {', '.join(found[:_SHOWN])}: a placeholder the assistant reads in place of a value it is never given. "
            "Saving it would put those letters where the real value is. Nothing was changed. "
            "To change other fields, call k8s_patch_resource with those fields only, which leaves the rest as it is "
            "(kubectl apply takes out a key it applied before and a manifest leaves out). "
            "A new value has to come from the user, in this chat or on the screen.")
