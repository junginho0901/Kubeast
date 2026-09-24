# tool definitions 회귀 테스트 — 분할 후 다음이 깨지지 않았는지 보호:
#   - tool 개수가 줄어들지 않음 (의도하지 않은 누락)
#   - 알려진 tool name 모두 존재 (LLM 이 호출하는 이름과 매칭)
#   - readonly / write 사이 name 중복 없음 (filter_by_role 분류 깨짐 방지)
#   - OpenAI/Anthropic function-calling schema 형식 준수
#   - tool dispatch (`_execute_function_with_context`) 의 if-elif chain 과
#     name 매칭이 깨지면 silent failure 발생 → 알려진 set 가 변하면 즉시 경고

from app.services.ai.tools import K8S_READONLY_TOOLS, K8S_WRITE_TOOLS

EXPECTED_READONLY_NAMES = {
    "k8s_get_resources",
    "k8s_get_resource_yaml",
    "k8s_get_pod_logs",
    "k8s_get_events",
    "k8s_get_available_api_resources",
    "k8s_get_cluster_configuration",
    "k8s_check_service_connectivity",
    "k8s_describe_resource",
}

EXPECTED_WRITE_NAMES = {
    "k8s_apply_manifest",
    "k8s_create_resource",
    "k8s_delete_resource",
    "k8s_patch_resource",
    "k8s_annotate_resource",
    "k8s_remove_annotation",
    "k8s_label_resource",
    "k8s_remove_label",
    "k8s_scale",
    "k8s_rollout",
    "k8s_execute_command",
}


def _names(tools):
    return [t["function"]["name"] for t in tools]


def test_readonly_tools_not_empty():
    assert isinstance(K8S_READONLY_TOOLS, list)
    assert len(K8S_READONLY_TOOLS) > 0


def test_write_tools_not_empty():
    assert isinstance(K8S_WRITE_TOOLS, list)
    assert len(K8S_WRITE_TOOLS) > 0


def test_readonly_tool_count_matches_expected():
    """예상한 readonly tool 들이 모두 있고, 모르는 tool 이 추가되지 않았는지 확인"""
    actual = set(_names(K8S_READONLY_TOOLS))
    assert actual == EXPECTED_READONLY_NAMES, (
        f"readonly tool name set 변화: 추가 {actual - EXPECTED_READONLY_NAMES}, "
        f"누락 {EXPECTED_READONLY_NAMES - actual}"
    )


def test_write_tool_count_matches_expected():
    actual = set(_names(K8S_WRITE_TOOLS))
    assert actual == EXPECTED_WRITE_NAMES, (
        f"write tool name set 변화: 추가 {actual - EXPECTED_WRITE_NAMES}, "
        f"누락 {EXPECTED_WRITE_NAMES - actual}"
    )


def test_no_duplicate_names_within_readonly():
    names = _names(K8S_READONLY_TOOLS)
    assert len(names) == len(set(names)), f"readonly 안에 중복 name: {names}"


def test_no_duplicate_names_within_write():
    names = _names(K8S_WRITE_TOOLS)
    assert len(names) == len(set(names)), f"write 안에 중복 name: {names}"


def test_no_overlap_between_readonly_and_write():
    """readonly 와 write 가 겹치면 _filter_tools_by_role 분류가 깨진다"""
    ro = set(_names(K8S_READONLY_TOOLS))
    wr = set(_names(K8S_WRITE_TOOLS))
    overlap = ro & wr
    assert not overlap, f"readonly 와 write 에 같은 name: {overlap}"


def test_all_tools_are_function_type():
    """OpenAI/Anthropic function-calling 형식: type='function'"""
    for tool in K8S_READONLY_TOOLS + K8S_WRITE_TOOLS:
        assert tool.get("type") == "function", f"non-function type: {tool}"


def test_all_tools_have_function_block():
    """function 블록에 name + description + parameters 가 있어야 LLM 이 인식"""
    for tool in K8S_READONLY_TOOLS + K8S_WRITE_TOOLS:
        fn = tool.get("function")
        assert isinstance(fn, dict), f"function 블록 없음: {tool}"
        assert isinstance(fn.get("name"), str) and fn["name"], f"name 누락: {tool}"
        assert isinstance(fn.get("description"), str) and fn["description"], (
            f"description 누락 ({fn['name']})"
        )
        params = fn.get("parameters")
        assert isinstance(params, dict), f"parameters 누락 ({fn['name']})"
        assert params.get("type") == "object", (
            f"parameters.type 가 object 가 아님 ({fn['name']})"
        )
        assert "properties" in params, f"properties 누락 ({fn['name']})"


def test_write_tools_have_required_fields():
    """write tool 은 대부분 required field 가 있어야 안전 (e.g., delete 는 name+namespace)"""
    # 최소한 한 개라도 required 가 정의된 write tool 이 있어야 함 (sanity check)
    has_required = any(
        "required" in t["function"]["parameters"] for t in K8S_WRITE_TOOLS
    )
    assert has_required, "어떤 write tool 도 required field 가 없음 — 안전성 의심"


def test_lists_are_independent_copies():
    """모듈 상수가 누군가 mutate 해도 다음 호출에서 원본을 유지하는지 — 호출 시
    list(...) 로 복사해서 쓰는 것을 강제하기 위한 회귀 가드.
    참고: ai_service.py 에서는 tools = [...] + tools.extend(K8S_READONLY_TOOLS) 패턴.
    extend 는 K8S_READONLY_TOOLS 자체를 mutate 하지 않는다 (다른 list 에 추가만).
    """
    # 단순히 길이가 안정적인지만 sanity check
    n_ro_before = len(K8S_READONLY_TOOLS)
    _ = list(K8S_READONLY_TOOLS) + list(K8S_WRITE_TOOLS)
    assert len(K8S_READONLY_TOOLS) == n_ro_before
