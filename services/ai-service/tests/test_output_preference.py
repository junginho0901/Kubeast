"""A chat question narrows its tools to one output form's only where it asks for that form (kubectl's -o/--output,
"as yaml", "in json format", "wide output", "output json", "show the yaml", "json으로", "yaml 형식", "yaml을 보여줘",
"와이드로"); one that only names JSON, YAML or wide keeps every tool, as does the AI evaluation's question with its
rca block."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.ai.intent import detect_output_preference, filter_tools_for_output_preference
from app.services.ai.tools import get_tools_definition

TOOLS = get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))
ALLOWED = {"json": {"k8s_get_resources"}, "wide": {"k8s_get_resources"}, "yaml": {"k8s_get_resource_yaml"}}


def _scorer():
    path = Path(__file__).resolve().parents[3] / "scripts" / "ai_eval_rca.py"
    spec = importlib.util.spec_from_file_location("ai_eval_rca_formats", path)
    scorer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scorer)
    return scorer


def _names(tools):
    return {tool["function"]["name"] for tool in tools}


MENTIONS = [
    "my app fails to parse JSON",
    "Answer with one JSON object.",
    "the app can't parse the request body as JSON",
    "kubectl get pods -o jsonpath='{.items[*].metadata.name}' prints nothing",
    "the json config of the web app was changed an hour ago",
    "why does the cluster-wide network policy drop traffic?",
    "orders from nationwide stores are failing",
    "worldwide traffic to the shop is slow",
    "a wide range of pods restart",
    "the cluster wide output is empty",
    "the logs are in JSON format and the collector fails on them",
    "the yaml output of helm template is wrong",
    "its output json has no status field",
    "there is a typo in yaml",
    "kubectl apply -f deploy.yaml failed",
    "kubectl get pods -o custom-columns=NAME:.metadata.name shows web-1 twice",
    "앱이 JSON 파싱에 실패해",
    "yaml 파일 들여쓰기가 틀렸어",
    "로그가 json 형식이라 파싱이 안 돼",
    "로그를 json으로 남기는데 수집이 안 돼",
    "json 로그가 안 보여",
    "yaml로 된 설정이 깨졌어",
    "클러스터 와이드로 적용된 정책 때문에 트래픽이 막혀",
    "클러스터와이드 정책이 바뀌었어",
    "deploy.yaml로 배포했는데 파드가 안 떠",
    "I get the json error from the api",
    "yaml이 안 보여",
    "web 디플로이먼트 yaml을 고쳐줘",
    # e2e ai-stdout-dump.spec.ts: an example to write, nothing to read
    "DB 비밀번호는 hunter2 입니다. 이 값을 담는 ConfigMap YAML 예시를 그대로 적어 보여줘.",
]

ASKED = [
    ("kubectl get pods -o wide", "wide"),
    ("get deploy web -o yaml", "yaml"),
    ("get deploy web -oyaml", "yaml"),
    ("get pods -o=json", "json"),
    ("get cm app -o yml", "yaml"),
    ("kubectl get nodes --output wide", "wide"),
    ("kubectl get svc --output=json", "json"),
    ("kubectl get deploy web --output yaml", "yaml"),
    ("Show the web deployment as YAML", "yaml"),
    ("list the pods in shop as JSON", "json"),
    ("show deployment web in yaml", "yaml"),
    ("pods in shop in JSON format", "json"),
    ("yaml output for deployment web please", "yaml"),
    ("show the nodes in wide format", "wide"),
    ("nodes, wide output", "wide"),
    ("output json for the shop pods", "json"),
    ("output as yaml: deployment web", "yaml"),
    ("show me the YAML of configmap app in shop", "yaml"),
    ("give me web's json", "json"),
    ("shop 네임스페이스 파드를 json으로 보여줘", "json"),
    ("web 디플로이먼트 yaml로 줘", "yaml"),
    ("configmap app을 yml로 보여줘", "yaml"),
    ("파드 목록 json 형식으로 보여줘", "json"),
    ("web 디플로이먼트 yaml 형식 출력", "yaml"),
    ("노드를 wide로 보여줘", "wide"),
    ("노드 목록 와이드로 보여줘", "wide"),
    ("노드 목록 와이드 형식으로", "wide"),
    ("파드 목록 json 출력해줘", "json"),
    ("web 디플로이먼트 yaml 보여줘", "yaml"),
    # e2e ai-redaction.spec.ts
    ("e2e-ns 네임스페이스의 configmap e2e-cm 의 YAML 을 k8s_get_resource_yaml 로 보여줘", "yaml"),
    ("kubeast 네임스페이스의 secret kubeast-secrets 의 YAML 을 k8s_get_resource_yaml 로 보여줘", "yaml"),
]


@pytest.mark.parametrize("text", MENTIONS)
def test_a_question_that_only_names_a_form_keeps_every_tool(text):
    assert detect_output_preference(text) is None
    assert filter_tools_for_output_preference(TOOLS, text) is TOOLS


def test_the_ai_evaluations_question_with_its_rca_block_keeps_every_tool():
    scorer = _scorer()
    question = scorer.question_with_format("Checkout in the shop namespace fails since a few minutes ago. Why?",
                                           "rca_block_v0")
    assert scorer.RCA_BLOCK_V0 in question and "JSON object" in scorer.RCA_BLOCK_V0
    assert detect_output_preference(scorer.RCA_BLOCK_V0) is None
    assert detect_output_preference(question) is None
    assert filter_tools_for_output_preference(TOOLS, question) is TOOLS


@pytest.mark.parametrize("text,form", ASKED)
def test_a_question_that_asks_for_a_form_gets_that_forms_tools(text, form):
    assert detect_output_preference(text) == form
    assert _names(filter_tools_for_output_preference(TOOLS, text)) == ALLOWED[form]


def test_events_logs_and_describe_named_beside_a_form_keep_their_tools():
    text = "kubectl get pod web-1 -o yaml, with its events, logs and describe"
    assert _names(filter_tools_for_output_preference(TOOLS, text)) == {
        "k8s_get_resource_yaml", "k8s_get_events", "k8s_get_pod_logs", "k8s_describe_resource"}
    korean = "노드를 wide로 보여주고 이벤트도"
    assert _names(filter_tools_for_output_preference(TOOLS, korean)) == {"k8s_get_resources", "k8s_get_events"}


def test_yaml_then_wide_then_json_when_more_than_one_is_asked():
    assert detect_output_preference("get pods -o json, and web as yaml") == "yaml"
    assert detect_output_preference("get pods -o json and nodes -o wide") == "wide"


def test_no_tool_of_the_form_falls_back_to_every_tool():
    tools = [tool for tool in TOOLS if _names([tool]) - {"k8s_get_resources", "k8s_get_resource_yaml"}]
    assert filter_tools_for_output_preference(tools, "get pods -o json") is tools
    assert detect_output_preference(None) is None
