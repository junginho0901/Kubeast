"""Data placed between a prompt's delimiters must not be able to end them, or the model reads what follows as
something other than data. The rest of the text stays as it came."""
import re

_ARROWS = re.compile(r">>(?=>)")


def inside_arrows(text: str) -> str:
    """For text between <<< and >>> markers: no run of three > is left."""
    return _ARROWS.sub(r">>\\", text)


def inside_tag(text: str, tag: str) -> str:
    """For text between <tag> and </tag>: a closing tag, however it is spaced or cased, is written <\\/tag."""
    return re.sub(rf"<\s*/\s*{re.escape(tag)}", rf"<\\/{tag}", text, flags=re.IGNORECASE)
