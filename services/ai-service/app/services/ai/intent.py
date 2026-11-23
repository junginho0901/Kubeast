"""
사용자 메시지 의도/출력 형식 감지 헬퍼.

ai_service.py 에서 추출. self 의존이 없는 순수 함수 모음.
"""
import re
from typing import Callable, Dict, List, Optional, Sequence, Tuple

# An output form counts only where the message asks for one: kubectl's -o/--output, "as yaml", "in json format",
# "wide output", "output json", "show the yaml", "json으로", "yaml 형식", "yaml을 보여줘", "와이드로". A word that
# only names JSON, YAML or wide ("parse JSON", "one JSON object", "jsonpath", "cluster-wide", "json 로그") asks for none.
_PREFERENCE = {"json": "json", "yaml": "yaml", "yml": "yaml", "wide": "wide", "와이드": "wide"}
_FORM = r"(json|ya?ml|wide)"
_KO_FORM = r"(json|ya?ml|wide|와이드)"
_AT = r"(?<![\w./-])"  # not inside a word, a file name (deploy.yaml) or a path
_END = r"(?![\w-])"  # not jsonpath, json-…, wideband
_CLAUSE_END = re.compile(r"[.,;:!?\n]")
_DATA_WORDS = re.compile(r"(?:pars|decod|encod|serializ|deserializ|marshal|unmarshal|emit|logg|stor|send|receiv"
                         r"|load)\w*|logs?|sent")
_COPULAS = re.compile(r"is|are|was|were|be|been")
_DETERMINERS = re.compile(r"the|its|their|my|our|your|his|her|this|that|these|those|\w+['’]s")
_SHOW_WORDS = re.compile(r"show|get|give|list|print|display|dump|output|return|fetch|view|see|render|format|export")
_FAULT_WORDS = re.compile(r"typos?|errors?|mistakes?|bugs?|problems?|issues?|wrong|broken|invalid|syntax|indentation")
_NOUNS_AFTER = re.compile(r"(?:object|array|string|block|file|payload|document|schema|config|configuration|value|log"
                          r"|line|record|field|key|message|response|request|event|error|parser)s?|bod(?:y|ies)|data"
                          r"|parsing|is|are|was|were|has|had|looks|seems")
_WIDE_SCOPES = {"cluster", "world", "nation", "namespace", "system", "site", "company", "클러스터", "네임스페이스"}
_KO_WRITTEN_IN = re.compile(r"\s*(?:된|되|돼|작성|저장|파싱|인코딩|디코딩|직렬화|기록|로깅|남|들어|받|보내|보낸|오|온|와|응답)")


def _words(text: str) -> List[str]:
    return [w.strip("\"'`*[]{}<>()") for w in text.split()]


def _clause_before(text: str, at: int) -> List[str]:
    return _words(_CLAUSE_END.split(text[:at])[-1])


def _clause_after(rest: str) -> List[str]:
    return _words(_CLAUSE_END.split(rest, 1)[0])


def _mention(before: List[str], rest: str) -> bool:
    """'parse the body as JSON', 'logs are in JSON format', 'as a JSON object', 'yaml output is wrong'."""
    after = _clause_after(rest)
    return any(_DATA_WORDS.fullmatch(w) for w in before) or any(_COPULAS.fullmatch(w) for w in before[-3:]) \
        or bool(after and _NOUNS_AFTER.fullmatch(after[0]))


def _named(before: List[str], rest: str) -> bool:
    """A mention, or a form after 'the', 'its', "app's" …: 'the json output', 'its output json'."""
    return _mention(before, rest) or bool(before and _DETERMINERS.fullmatch(before[-1]))


def _bare_in(before: List[str], rest: str) -> bool:
    """'in yaml' asks only at the end of a clause asking to show something: 'show web in yaml', not 'a typo in yaml'."""
    after = _clause_after(rest)
    if after and after[0] not in ("please", "instead"):
        return True
    return not any(_SHOW_WORDS.fullmatch(w) for w in before) or any(_FAULT_WORDS.fullmatch(w) for w in before[-3:]) \
        or _mention(before, rest)


def _ko_written_in(before: List[str], rest: str) -> bool:
    """'json으로 남기는 로그', 'yaml로 된 설정': the form something is written in, not the answer's."""
    return bool(_KO_WRITTEN_IN.match(rest))


_ASKED: Sequence[Tuple[re.Pattern, Optional[Callable[[List[str], str], bool]]]] = (
    # -o json, -ojson, -o=yaml, --output wide, --output=json (not -o jsonpath=…, -o custom-columns=…)
    (re.compile(r"(?<![\w-])(?:-o\s*=?\s*|--output(?:\s*=\s*|\s+))" + _FORM + _END), None),
    (re.compile(_AT + r"as\s+(json|ya?ml)" + _END), _mention),
    (re.compile(_AT + r"in\s+(json|ya?ml)" + _END), _bare_in),
    (re.compile(_AT + _FORM + r"\s+(?:format|output)" + _END), _named),
    (re.compile(_AT + r"output(?:\s*[:=]\s*|\s+(?:(?:as|in)\s+)?)" + _FORM + _END), _named),
    (re.compile(r"(?<![\w-])(?:show|give|get|print|dump|display|fetch)\s+(?:me\s+|us\s+)?"
                r"(?:the\s+|its\s+|their\s+|[\w-]+['’]s\s+)?(json|ya?ml)" + _END), _mention),
    (re.compile(_AT + _KO_FORM + r"\s*(?:형식|포맷|형태)?\s*(?:으로|로)(?!\w)"), _ko_written_in),
    (re.compile(_AT + _KO_FORM + r"\s*(?:형식|포맷)(?=\s*(?:출력|[.?!]|$))"), None),
    # "yaml 을 k8s_get_resource_yaml 로 보여줘", "json 출력해줘", "yaml 보여줘" (not "yaml이 안 보여", "yaml을 고쳐줘")
    (re.compile(_AT + _KO_FORM + r"\s*(?:(?:을|를)\s*(?:\S+\s+){0,2}?)?(?:보여|조회|가져와|뽑아|출력\s*해)"), None),
)


def detect_output_preference(text: Optional[str]) -> Optional[str]:
    """The output form the message asks for (yaml, then wide, then json when it asks for more than one), else None."""
    if not isinstance(text, str):
        return None
    lowered = text.lower()
    asked = set()
    for pattern, refused in _ASKED:
        for m in pattern.finditer(lowered):
            pref = _PREFERENCE[m.group(1)]
            if pref == "wide" and set(_clause_before(lowered, m.start(1))[-1:]) & _WIDE_SCOPES:  # "cluster wide output"
                continue
            if refused is not None and refused(_clause_before(lowered, m.start()), lowered[m.end():]):
                continue
            asked.add(pref)
    return next((pref for pref in ("yaml", "wide", "json") if pref in asked), None)


def mentions_events(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "event" in lowered or "이벤트" in lowered


def mentions_logs(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "log" in lowered or "로그" in lowered


def mentions_describe(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "describe" in lowered or "상세" in lowered or "디스크라이브" in lowered


def filter_tools_for_output_preference(tools: List[Dict], user_text: Optional[str]) -> List[Dict]:
    pref = detect_output_preference(user_text)
    if pref not in {"json", "wide", "yaml"}:
        return tools

    want_events = mentions_events(user_text)
    want_logs = mentions_logs(user_text)
    want_describe = mentions_describe(user_text)

    # Strongly prefer format-specific tools when output format is requested.
    if pref == "yaml":
        allow = {"k8s_get_resource_yaml"}
    else:
        allow = {"k8s_get_resources"}
    if want_events:
        allow.add("k8s_get_events")
    if want_logs:
        allow.add("k8s_get_pod_logs")
    if want_describe:
        allow.add("k8s_describe_resource")

    filtered = []
    for tool in tools:
        fn = tool.get("function", {}).get("name")
        if fn in allow:
            filtered.append(tool)

    # If for some reason nothing matched, fall back to original tools
    return filtered or tools
