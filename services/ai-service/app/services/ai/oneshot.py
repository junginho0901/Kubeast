"""
LLM 단발(non-stream) 호출 메서드 모음.

ai_service.AIService 의 analyze_logs / troubleshoot / chat / explain_resource /
suggest_optimization 를 그대로 추출. 프롬프트(특히 한국어 트리플쿼트 문자열)는
원본과 바이트 단위로 동일해야 한다.

각 함수는 첫 인자로 AIService 인스턴스를 받는다. AIService 는 1-2 줄짜리
래퍼 메서드를 통해 호출한다.
"""
from typing import TYPE_CHECKING, List
import json

from app.models.ai import (
    ChatRequest,
    ChatResponse,
    LogAnalysisRequest,
    LogAnalysisResponse,
    SeverityLevel,
    TroubleshootRequest,
    TroubleshootResponse,
)
from app.services.ai import formatters
from app.services.ai.tools import K8S_READONLY_TOOLS

if TYPE_CHECKING:
    from app.services.ai_service import AIService


async def analyze_logs(service: "AIService", request: LogAnalysisRequest) -> LogAnalysisResponse:
    """로그 분석"""
    
    # 에러 패턴 추출
    error_patterns = service._extract_error_patterns(request.logs)
    
    # GPT를 사용한 상세 분석
    prompt = f"""
다음은 Kubernetes Pod의 로그입니다:

Namespace: {request.namespace}
Pod: {request.pod_name}
Container: {request.container or 'N/A'}

로그:
```
{request.logs[:4000]}  # 토큰 제한을 위해 일부만
```

다음을 분석해주세요:
1. 로그 요약
2. 발견된 에러의 근본 원인
3. 해결 방안 (구체적이고 실행 가능한 단계)
4. 관련된 일반적인 이슈들

JSON 형식으로 응답해주세요:
{{
  "summary": "로그 요약",
  "root_cause": "근본 원인",
  "recommendations": ["해결방안1", "해결방안2"],
  "related_issues": ["관련이슈1", "관련이슈2"]
}}
"""
    
    try:
        print(f"[AI Service] Analyze Logs API 호출 - 요청 모델: {service.model}", flush=True)
        _base_kwargs = dict(
            model=service.model,
            messages=[
                {"role": "system", "content": "당신은 Kubernetes 전문가이자 DevOps 엔지니어입니다. 로그를 분석하고 문제를 해결하는 데 도움을 줍니다. 반드시 JSON 형식으로만 응답하세요."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
        )
        try:
            response = await service.client.chat.completions.create(**_base_kwargs, response_format={"type": "json_object"})
        except Exception:
            # 모델이 response_format을 지원하지 않는 경우 fallback
            response = await service.client.chat.completions.create(**_base_kwargs)
        print(f"[AI Service] Analyze Logs API 응답 - 실제 사용 모델: {response.model}", flush=True)
        
        # OpenAI 응답 전체 로그 출력
        import json
        response_dict = {
            "id": response.id,
            "model": response.model,
            "created": response.created,
            "choices": [
                {
                    "index": choice.index,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                    },
                    "finish_reason": choice.finish_reason
                } for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                "completion_tokens": response.usage.completion_tokens if response.usage else None,
                "total_tokens": response.usage.total_tokens if response.usage else None
            } if response.usage else None
        }
        print(f"[OPENAI RESPONSE][analyze_logs] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
        
        result = json.loads(response.choices[0].message.content)
        
        return LogAnalysisResponse(
            summary=result.get("summary", ""),
            errors=error_patterns,
            root_cause=result.get("root_cause"),
            recommendations=result.get("recommendations", []),
            related_issues=result.get("related_issues", [])
        )
    except Exception as e:
        # Fallback: GPT 없이도 기본 분석 제공
        return LogAnalysisResponse(
            summary="로그에서 에러 패턴을 감지했습니다.",
            errors=error_patterns,
            root_cause="상세 분석을 위해 AI 서비스가 필요합니다.",
            recommendations=["로그를 확인하고 에러 메시지를 검색하세요."],
            related_issues=[]
        )



async def troubleshoot(service: "AIService", request: TroubleshootRequest) -> TroubleshootResponse:
    """종합 트러블슈팅"""
    
    # 리소스 정보 수집
    context = await service._gather_resource_context(request)
    
    prompt = f"""
다음 Kubernetes 리소스에 문제가 발생했습니다:

Namespace: {request.namespace}
Resource Type: {request.resource_type}
Resource Name: {request.resource_name}

컨텍스트:
{context}

다음을 분석해주세요:
1. 진단 (무엇이 문제인가?)
2. 심각도 (critical/high/medium/low/info)
3. 근본 원인들
4. 해결 방안들 (단계별로 구체적으로)
5. 예방 조치

JSON 형식으로 응답해주세요:
{{
  "diagnosis": "진단 내용",
  "severity": "심각도",
  "root_causes": ["원인1", "원인2"],
  "solutions": [
    {{"step": 1, "action": "조치1", "command": "kubectl 명령어"}},
    {{"step": 2, "action": "조치2", "command": "kubectl 명령어"}}
  ],
  "preventive_measures": ["예방조치1", "예방조치2"],
  "estimated_fix_time": "예상 해결 시간"
}}
"""
    
    try:
        print(f"[AI Service] Troubleshoot API 호출 - 요청 모델: {service.model}", flush=True)
        _base_kwargs = dict(
            model=service.model,
            messages=[
                {"role": "system", "content": "당신은 Kubernetes 트러블슈팅 전문가입니다. 반드시 JSON 형식으로만 응답하세요."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
        )
        try:
            response = await service.client.chat.completions.create(**_base_kwargs, response_format={"type": "json_object"})
        except Exception:
            response = await service.client.chat.completions.create(**_base_kwargs)
        print(f"[AI Service] Troubleshoot API 응답 - 실제 사용 모델: {response.model}", flush=True)
        
        # OpenAI 응답 전체 로그 출력
        import json
        response_dict = {
            "id": response.id,
            "model": response.model,
            "created": response.created,
            "choices": [
                {
                    "index": choice.index,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                    },
                    "finish_reason": choice.finish_reason
                } for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                "completion_tokens": response.usage.completion_tokens if response.usage else None,
                "total_tokens": response.usage.total_tokens if response.usage else None
            } if response.usage else None
        }
        print(f"[OPENAI RESPONSE][troubleshoot] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
        
        result = json.loads(response.choices[0].message.content)
        
        return TroubleshootResponse(
            diagnosis=result.get("diagnosis", ""),
            severity=SeverityLevel(result.get("severity", "medium")),
            root_causes=result.get("root_causes", []),
            solutions=result.get("solutions", []),
            preventive_measures=result.get("preventive_measures", []),
            estimated_fix_time=result.get("estimated_fix_time")
        )
    except Exception as e:
        raise Exception(f"Troubleshooting failed: {e}")



async def chat(service: "AIService", request: ChatRequest) -> ChatResponse:
    """AI 챗봇 with Function Calling"""
    
    # 시스템 메시지
    system_message = """
    당신은 Kubernetes 클러스터를 관리하는 AI Agent입니다.
    사용자의 질문에 답하기 위해 필요한 경우 Kubernetes API를 직접 호출할 수 있습니다.
    실시간 클러스터 정보를 조회하여 정확한 답변을 제공하세요.

    **Language**: Respond in the same language as the user's latest message
    (Korean → Korean, English → English, etc.). Keep commands/code/resource names verbatim.

    중요: 사용자가 네임스페이스를 명시하지 않은 요청에서 `default`를 임의로 가정하지 마세요.
    사용자가 리소스 이름을 "대충" 던지는 경우(정확한 전체 이름이 아닌 식별자/부분 문자열)에는,
    먼저 `k8s_get_resources`를 `all_namespaces=true`로 호출해 모든 네임스페이스에서 후보를 찾고
    그 결과의 `namespace`/`name`을 사용해 후속 도구(로그/describe 등)를 호출하세요.
    YAML 요청은 `k8s_get_resource_yaml`에서만 지원합니다. 그 외에는 JSON으로 조회하고 화면에는 kubectl 테이블로 표시합니다.
    """
    
    # 메시지 변환
    messages = [{"role": "system", "content": system_message}]
    for msg in request.messages:
        messages.append({
            "role": msg.role,
            "content": service._sanitize_history_content(msg.role, msg.content),
        })

    # 컨텍스트 추가 (마지막 user/assistant 메시지에 append)
    if request.context:
        context_str = f"\n\n현재 컨텍스트:\n{request.context}"
        messages[-1]["content"] += context_str

    # Inject language directive after history so it overrides Korean-biased prompt.
    latest_user_msg = ""
    for msg in reversed(request.messages):
        if msg.role == "user" and isinstance(msg.content, str):
            latest_user_msg = msg.content
            break
    messages.append({
        "role": "system",
        "content": service._build_language_directive(latest_user_msg),
    })
    
    # Function definitions
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_cluster_overview",
                "description": "클러스터 전체 개요 (네임스페이스, Pod, Service 등의 총 개수)를 조회합니다",
                "parameters": {"type": "object", "properties": {}}
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_pod_metrics",
                "description": "Pod 리소스 사용량(CPU/Memory) 조회 (kubectl top pods)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "namespace": {"type": "string", "description": "네임스페이스 (선택)"}
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_node_metrics",
                "description": "Node 리소스 사용량(CPU/Memory) 조회 (kubectl top nodes)",
                "parameters": {"type": "object", "properties": {}}
            }
        }
    ]
    tools.extend(K8S_READONLY_TOOLS)
    # YAML/WIDE 요청 시 legacy JSON-only 도구는 제외
    latest_user_message = next((m.content for m in reversed(request.messages) if m.role == "user"), None)
    tools = service._filter_tools_for_output_preference(tools, latest_user_message)
    
    try:
        # 첫 번째 GPT 호출 (function calling 포함)
        print(f"[AI Service] Chat API 호출 - 요청 모델: {service.model}", flush=True)
        _chat_kwargs = dict(
            model=service.model,
            messages=messages,
            tools=tools,
            temperature=0.7,
        )
        try:
            response = await service.client.chat.completions.create(**_chat_kwargs, tool_choice="auto")
        except Exception:
            response = await service.client.chat.completions.create(**_chat_kwargs)
        print(f"[AI Service] Chat API 응답 - 실제 사용 모델: {response.model}", flush=True)
        
        # OpenAI 응답 전체 로그 출력
        import json
        response_dict = {
            "id": response.id,
            "model": response.model,
            "created": response.created,
            "choices": [
                {
                    "index": choice.index,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                    },
                    "finish_reason": choice.finish_reason
                } for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                "completion_tokens": response.usage.completion_tokens if response.usage else None,
                "total_tokens": response.usage.total_tokens if response.usage else None
            } if response.usage else None
        }
        print(f"[OPENAI RESPONSE][chat first] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
        
        response_message = response.choices[0].message
        tool_calls = response_message.tool_calls
        
        # Function calling이 있으면 실행
        if tool_calls:
            messages.append(response_message)
            
            for tool_call in tool_calls:
                function_name = tool_call.function.name
                function_args = json.loads(tool_call.function.arguments)
                
                # 함수 실행
                function_response = await service._execute_function(function_name, function_args)
                formatted_result, _, _ = formatters._format_tool_result(
                    function_name,
                    function_args,
                    function_response,
                )
                tool_message_content = formatters._truncate_tool_result_for_llm(formatted_result)
                
                messages.append({
                    "tool_call_id": tool_call.id,
                    "role": "tool",
                    "name": function_name,
                    "content": tool_message_content
                })
            
            # 함수 결과를 바탕으로 최종 답변 생성
            print(f"[AI Service] Chat API 두 번째 호출 - 요청 모델: {service.model}", flush=True)
            second_response = await service.client.chat.completions.create(
                model=service.model,
                messages=messages,
                temperature=0.7
            )
            print(f"[AI Service] Chat API 두 번째 응답 - 실제 사용 모델: {second_response.model}", flush=True)
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": second_response.id,
                "model": second_response.model,
                "created": second_response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in second_response.choices
                ],
                "usage": {
                    "prompt_tokens": second_response.usage.prompt_tokens if second_response.usage else None,
                    "completion_tokens": second_response.usage.completion_tokens if second_response.usage else None,
                    "total_tokens": second_response.usage.total_tokens if second_response.usage else None
                } if second_response.usage else None
            }
            print(f"[OPENAI RESPONSE][chat second] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            message = second_response.choices[0].message.content
        else:
            message = response_message.content
        
        suggestions = service._extract_suggestions(message)
        
        return ChatResponse(
            message=message,
            suggestions=suggestions,
            actions=[]
        )
    except Exception as e:
        raise Exception(f"Chat failed: {e}")



async def explain_resource(service: "AIService", resource_type: str, resource_yaml: str) -> str:
    """리소스 YAML 설명"""
    
    prompt = f"""
다음 Kubernetes {resource_type} 리소스를 분석해주세요:

```yaml
{resource_yaml}
```

다음을 설명해주세요:
1. 이 리소스가 하는 일
2. 주요 설정 설명
3. 잠재적 문제점이나 개선 사항
4. 베스트 프랙티스 권장사항
"""
    
    try:
        response = await service.client.chat.completions.create(
            model=service.model,
            messages=[
                {"role": "system", "content": "당신은 Kubernetes 리소스 설정 전문가입니다."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.5
        )
        
        # OpenAI 응답 전체 로그 출력
        import json
        response_dict = {
            "id": response.id,
            "model": response.model,
            "created": response.created,
            "choices": [
                {
                    "index": choice.index,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                    },
                    "finish_reason": choice.finish_reason
                } for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                "completion_tokens": response.usage.completion_tokens if response.usage else None,
                "total_tokens": response.usage.total_tokens if response.usage else None
            } if response.usage else None
        }
        print(f"[OPENAI RESPONSE][explain_resource] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
        
        return response.choices[0].message.content
    except Exception as e:
        raise Exception(f"Resource explanation failed: {e}")



async def suggest_optimization(service: "AIService", namespace: str) -> List[str]:
    """리소스 최적화 제안"""

    observations = await service._build_optimization_observations(namespace)

    prompt = f"""
아래는 Kubernetes 네임스페이스의 **관측 데이터(스펙/상태/메트릭/이벤트)** 요약입니다.
이 데이터에 근거해서 리소스 최적화 제안을 작성하세요.

중요:
- 추측/일반론만 쓰지 말고, 반드시 숫자/리소스명 등 관측값을 인용하세요.
- 관측 데이터에 없는 내용은 "추가 확인 필요"로 남기세요.

관측 요약:
{observations['observations_md']}

요구사항:
1) 우선순위(High/Med/Low)와 기대효과(비용/성능/안정성)를 같이 표기
2) 각 항목마다 "근거(관측)"를 1줄 이상 포함
3) 가능하면 kubectl 패치 예시(짧게) 포함

출력은 마크다운으로, 리스트 형태로 작성하세요.
"""

    try:
        response = await service.client.chat.completions.create(
            model=service.model,
            messages=[
                {"role": "system", "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.5
        )
        
        # OpenAI 응답 전체 로그 출력
        import json
        response_dict = {
            "id": response.id,
            "model": response.model,
            "created": response.created,
            "choices": [
                {
                    "index": choice.index,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                    },
                    "finish_reason": choice.finish_reason
                } for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                "completion_tokens": response.usage.completion_tokens if response.usage else None,
                "total_tokens": response.usage.total_tokens if response.usage else None
            } if response.usage else None
        }
        print(f"[OPENAI RESPONSE][suggest_optimization] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
        
        content = response.choices[0].message.content
        # 제안을 리스트로 파싱
        suggestions = [line.strip() for line in content.split('\n') if line.strip() and (line.strip().startswith('-') or line.strip().startswith('•'))]
        
        return suggestions if suggestions else [content]
    except Exception as e:
        raise Exception(f"Optimization suggestion failed: {e}")

