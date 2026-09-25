# AI 응답 SSE 스트리밍 — ai_service.py 의 streaming 메서드들 (chat_stream /
# suggest_optimization_stream / session_chat_stream) 을 모듈 함수로 추출.
#
# 분할 패턴은 prompts.py / tools.py / language.py / tool_dispatch.py 와 동일:
# instance method 본문을 모듈 async generator 로 옮기고, AIService 의 메서드는
# `async for ... yield` wrapper 1~3줄로 위임. self.* → service.* 치환만.
#
# 4a (이번 PR): suggest_optimization_stream 만. chat_stream / session_chat_stream
# 은 후속 PR (4b / 4c) 에서 같은 파일에 추가.
#
# 변경 시 주의: SSE 형식 (`data: <json>\n\n`, `data: [DONE]\n\n`) 과 yield
# 순서 (observed → answer chunks → meta → usage → DONE) 가 frontend
# (useOptimizationStream / chatStreamManager) 와 정확히 매칭되어야 한다 —
# 형식 변경은 frontend 회귀.

import json
from typing import Callable, Optional, TYPE_CHECKING

from app.services.ai import formatters

from app.services.ai.prompts import SYSTEM_MESSAGE
from app.services.ai.tools import K8S_READONLY_TOOLS

if TYPE_CHECKING:
    from app.services.ai_service import AIService
    from app.models.ai import ChatRequest


async def suggest_optimization_stream(service: "AIService", namespace: str):
    """리소스 최적화 제안 (SSE 스트리밍)"""
    import asyncio
    import json
    from app.config import settings

    try:
        observations = await service._build_optimization_observations(namespace)
        observed_md = observations["observations_md"].rstrip() + "\n\n---\n\n## 최적화 제안 (AI)\n\n"

        # 1) 표(관측 데이터) 먼저 출력
        yield "data: " + json.dumps({"kind": "observed", "content": observed_md}, ensure_ascii=False) + "\n\n"
        await asyncio.sleep(0)

        # 2) 표/관측값 기반 draft(룰 기반)도 모델 입력에 포함해 일관성 강화 (UI에는 직접 출력 X)
        draft_plan = observations.get("action_plan_md", "").strip()

        prompt = f"""
    아래는 Kubernetes 네임스페이스의 관측 데이터(표)입니다. 이 표를 근거로 최적화 제안을 작성하세요.

    필수:
    - 제안에 반드시 표의 리소스명/수치(util, request/limit, avg usage 등)를 인용해서 근거를 달아주세요.
    - 표의 `usage`는 metrics-server 스냅샷(현재값)이며, 표의 `usage` 값은 파드별 스냅샷을 deployment 단위로 평균 낸 값입니다. `req/lim`은 컨테이너별 합(누락 시 과소추정)일 수 있습니다. 누락/불일치가 보이면 숫자 추천을 단정하지 말고 "먼저 YAML 확인/누락 보완"을 제안하세요.
    - 표에 없는 내용은 "추가 확인 필요"로 처리하고 추측하지 마세요.
    - 아래 'Draft (rules-based)'에 있는 수치/추천값이 있다면 **수치를 변경하지 말고** 문장/구조만 다듬어 주세요.

Observed data (markdown):
{observations["observations_md"]}

Draft (rules-based, keep numbers unchanged):
{draft_plan if draft_plan else "(none)"}

출력:
- 마크다운
- High/Medium/Low 우선순위
- 각 항목에 (효과: 비용/성능/안정성) + 근거 + 적용 예시(kubectl 짧게)

금지:
- 응답 전체를 ```markdown ... ``` 같은 코드 펜스로 감싸지 마세요. (그렇게 하면 UI에서 마크다운 렌더가 코드블록으로 깨집니다)
- 최상단을 ```로 시작하지 마세요.
"""

        max_tokens = int(getattr(settings, "OPENAI_OPTIMIZATION_MAX_TOKENS", 900) or 900)

        try:
            stream = await service.client.chat.completions.create(
                model=service.model,
                messages=[
                    {
                        "role": "system",
                        "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=max_tokens,
                stream=True,
                stream_options={"include_usage": True},
            )
        except Exception:
            stream = await service.client.chat.completions.create(
                model=service.model,
                messages=[
                    {
                        "role": "system",
                        "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=max_tokens,
                stream=True,
            )

        stream_usage = None
        finish_reason = None
        async for chunk in stream:
            if getattr(chunk, "usage", None) is not None:
                stream_usage = chunk.usage
            if chunk.choices and getattr(chunk.choices[0], "finish_reason", None) is not None:
                finish_reason = chunk.choices[0].finish_reason

            delta = chunk.choices[0].delta
            if delta and getattr(delta, "content", None):
                yield "data: " + json.dumps({"kind": "answer", "content": delta.content}, ensure_ascii=False) + "\n\n"

        yield (
            "data: "
            + json.dumps(
                {
                    "kind": "meta",
                    "usage_phase": "suggest_optimization_stream",
                    "finish_reason": finish_reason,
                    "max_tokens": max_tokens,
                },
                ensure_ascii=False,
            )
            + "\n\n"
        )

        if stream_usage is not None:
            yield (
                "data: "
                + json.dumps(
                    {
                        "kind": "usage",
                        "usage_phase": "suggest_optimization_stream",
                        "usage": {
                            "prompt_tokens": stream_usage.prompt_tokens,
                            "completion_tokens": stream_usage.completion_tokens,
                            "total_tokens": stream_usage.total_tokens,
                        },
                    },
                    ensure_ascii=False,
                )
                + "\n\n"
            )

        yield "data: [DONE]\n\n"
    except Exception as e:
        yield "data: " + json.dumps({"kind": "error", "error": str(e)}, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"

async def chat_stream(service: "AIService", request: "ChatRequest"):
    """AI 챗봇 스트리밍 with Function Calling"""
    import json
    
    # 시스템 메시지 (KAgent 스타일)
    system_message = """# Kubernetes AI Agent System Prompt

당신은 **KubeAssist**입니다. Kubernetes 트러블슈팅 및 운영에 특화된 고급 AI 에이전트입니다. Kubernetes 아키텍처, 컨테이너 오케스트레이션, 네트워킹, 스토리지 시스템, 리소스 관리에 대한 깊은 전문 지식을 보유하고 있습니다.

## 핵심 역량

- **전문 Kubernetes 지식**: Kubernetes 컴포넌트, 아키텍처, 오케스트레이션 원리, 리소스 관리
- **체계적 트러블슈팅**: 로그, 메트릭, 클러스터 상태를 분석하는 방법론적 접근
- **보안 우선 사고방식**: RBAC, Pod Security Policies, 보안 관행 우선
- **명확한 커뮤니케이션**: 명확하고 간결한 기술 정보 제공
- **안전 지향**: 최소 권한 원칙을 따르고 확인 없이 파괴적 작업 회피

## 운영 가이드라인

### 조사 프로토콜

1. **비침습적 시작**: 더 침습적인 작업 전에 읽기 전용 작업(get, describe)으로 시작
2. **점진적 확대**: 필요한 경우에만 더 상세한 조사로 확대
3. **모든 것을 문서화**: 모든 조사 단계와 작업의 명확한 기록 유지
4. **실행 전 확인**: 변경 사항을 실행하기 전에 잠재적 영향 고려
5. **롤백 계획**: 필요한 경우 변경 사항을 되돌릴 계획 항상 준비

### 문제 해결 프레임워크

1. **초기 평가**: 기본 클러스터 정보 수집, Kubernetes 버전 확인, 노드 상태 확인, 최근 변경 사항 검토
2. **문제 분류**: 애플리케이션 문제, 인프라 문제, 성능 문제, 보안 사고, 구성 오류
3. **리소스 분석**: Pod 상태 및 이벤트, 컨테이너 로그, 리소스 메트릭, 네트워크 연결, 스토리지 상태
4. **솔루션 구현**: 여러 솔루션 제안, 위험 평가, 구현 계획 제시, 테스트 전략, 롤백 절차

## 사용 가능한 도구

### 정보 수집 도구
- `k8s_get_resources`: kubectl get (json/wide) 형식 지원. 출력 형식 요청 시 우선 사용
- `k8s_get_resource_yaml`: 단일 리소스 YAML 조회 (kubectl get -o yaml)
- `k8s_describe_resource`: 리소스 상세 조회 (kubectl describe)
- `k8s_get_pod_logs`: Pod 로그 조회 (kubectl logs)
- `k8s_get_events`: 네임스페이스 이벤트 조회 (kubectl get events)
- `k8s_get_available_api_resources`: api-resources 조회
- `k8s_get_cluster_configuration`: 클러스터 구성 정보 조회
- `k8s_check_service_connectivity`: Service/Endpoint 연결성 확인
- `get_cluster_overview`: 클러스터 전체 요약(확장 기능)
- `get_pod_metrics`: Pod 리소스 사용량 조회(확장 기능, kubectl top pods)
- `get_node_metrics`: Node 리소스 사용량 조회(확장 기능, kubectl top nodes)

## 도구 사용 원칙

**매우 중요**: 사용자가 질문을 하면, **반드시 먼저 도구를 사용하여 실제 클러스터 상태를 확인**하세요. 절대 추측하지 마세요.

### 효율적 도구 사용 (최우선 규칙)
- **이미 필요한 정보를 확보했으면 추가 도구 호출 없이 즉시 분석/응답하세요.**
- 로그를 받았으면 바로 분석하세요. describe나 events를 추가로 호출하지 마세요 (로그만으로 판단이 불가능한 경우에만 추가 호출).
- 같은 데이터를 다른 파라미터로 재요청하지 마세요.
- **도구 호출은 최소한으로**: 보통 1~3회면 충분합니다. 정보가 충분하면 멈추고 답변하세요.

### 네임스페이스/리소스 식별 규칙
- 사용자가 네임스페이스를 명시하지 않은 요청에서 `default`를 임의로 가정하지 마세요.
- 사용자가 리소스 이름을 "대충" 던지는 경우, 먼저 `k8s_get_resources`를 `all_namespaces=true`로 호출해 후보를 찾은 뒤 후속 도구를 호출하세요.
- 후보가 여러 개면 나열하고 사용자에게 선택을 요청하거나, Running+Ready인 리소스를 우선하세요.

### 출력 포맷/툴 선택 규칙
- WIDE/`kubectl get` 스타일 요청 → `k8s_get_resources` 사용
- YAML 요청 → `k8s_get_resource_yaml` 사용

### 도구 호출 가이드
1. 사용자가 클러스터에 대해 질문하면, 관련 도구를 호출하세요 (일반적인 설명보다 실제 데이터 우선)
2. **문제 발견 시**: 로그나 이벤트 등 하나의 소스로 원인 파악이 되면 바로 분석하세요. 추가 도구 호출은 기존 정보로 판단이 불가능할 때만.
3. **컨텍스트 기억**: 이전 대화에서 수집한 정보를 기억하고 활용하세요

## 안전 프로토콜

1. **쓰기 전에 읽기**: 항상 정보 도구를 먼저 사용
2. **작업 설명**: 수정 도구를 사용하기 전에 수행할 작업과 이유 설명
3. **제한된 범위**: 문제 해결에 필요한 최소 범위로 변경 적용
4. **변경 확인**: 수정 후 적절한 정보 도구로 결과 확인
5. **위험한 명령 회피**: 명시적 확인 없이 잠재적으로 파괴적인 명령 실행 금지

## 응답 형식

**매우 중요**: 사용자 쿼리에 응답할 때 다음 형식을 **반드시** 따르세요:

1. **초기 평가 (Initial Assessment)**: 
   - 문제를 간략히 인정하고 상황에 대한 이해 확립
   - 예: "네, 클러스터의 죽어 있는 Pod들을 확인해드리겠습니다."

2. **정보 수집 (Information Gathering)**: 
   - 필요한 도구를 명시하고 호출
   - 예: "먼저 모든 네임스페이스의 Pod 상태를 확인하겠습니다."
   - **이 단계에서 tool call을 실행합니다**

3. **분석 (Analysis)**: 
   - **Tool call 결과를 받은 후**, 명확한 기술 용어로 상황 분석
   - 예: "현재 클러스터 전체 네임스페이스에서 죽어 있거나 비정상인 파드는 다음과 같습니다..."
   - **절대로 이 단계를 생략하지 마세요**

4. **권장 사항 (Recommendations)**: 
   - 구체적인 권장 사항과 추가로 사용할 도구 제시
   - 예: "죽어 있거나 문제 있는 파드들의 구체적인 이유를 분석하려면..."

5. **실행 계획 (Action Plan)**: 
   - 해결을 위한 단계별 계획 제시
   - 예: "1. 원인 추가 점검 필요 2. 필요 시 특정 파드들의 상세 진단 진행"

6. **검증 (Verification)**: 
   - 솔루션이 올바르게 작동했는지 확인하는 방법 설명
   - 예: "필요하시다면 어떤 파드를 우선 점검할지 알려주세요."

7. **지식 공유 (Knowledge Sharing)**: 
   - 관련 Kubernetes 개념에 대한 간략한 설명 포함
   - 예: "참고로, Pod 상태가 NotReady인 경우..."

**응답 완성도 규칙**:
- Tool을 호출한 후에는 **반드시 3단계(분석)부터 7단계(지식 공유)까지 완료**해야 합니다
- Tool call만 하고 끝내는 것은 **절대 금지**입니다
- 항상 완전한 문장으로 응답을 마무리하세요
- **절대로 문장 중간에 멈추지 마세요**, 특히 tool call 후에는 더욱 그렇습니다
- 최소한 분석 → 권장사항 → 실행 계획 순서로 완전한 응답을 제공해야 합니다

## Language / 언어

**Important**: Respond in the **same language as the user's latest message**.
- If the user writes in Korean, respond in Korean.
- If the user writes in English, respond in English.
- If the user writes in another language, respond in that language.
- Do NOT switch languages mid-conversation unless the user does.
- Keep commands, code, and resource names (pod/service/namespace names) verbatim.
- Korean technical terms may include the English original in parentheses (e.g., "파드(Pod)").
- Maintain a friendly yet professional tone.

항상 최소 침습적 접근으로 시작하고, 필요한 경우에만 진단을 확대하세요. 의심스러운 경우 변경을 권장하기 전에 더 많은 정보를 수집하세요.
"""
    
    # 메시지 변환
    messages = [{"role": "system", "content": system_message}]
    for msg in request.messages:
        messages.append({"role": msg.role, "content": msg.content})
    
    # 디버그: 메시지 개수 출력
    print(f"[DEBUG] Total messages: {len(messages)}, User messages: {len([m for m in messages if m['role'] == 'user'])}")
    
    # Function definitions
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_cluster_overview",
                "description": "클러스터 전체 개요를 조회합니다",
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
                        "namespace": {"type": "string", "description": "네임스페이스 이름 (선택)"}
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
    
    try:
        # 모델 정보를 스트림 첫 이벤트로 전송 (브라우저 콘솔에서 확인용)
        yield f"data: {json.dumps({'model_info': {'provider': service.provider, 'model': service.model, 'role': service.user_role}}, ensure_ascii=False)}\n\n"

        # 첫 번째 호출 (function calling 체크)
        _opt_kwargs = dict(
            model=service.model,
            messages=messages,
            tools=tools,
            temperature=0.7,
        )
        try:
            response = await service.client.chat.completions.create(**_opt_kwargs, tool_choice="auto")
        except Exception:
            response = await service.client.chat.completions.create(**_opt_kwargs)

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
        print(f"[OPENAI RESPONSE][chat_stream first] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)

        # 토큰 사용량 로그 (첫 번째 호출)
        usage = getattr(response, "usage", None)
        if usage is not None:
            print(
                f"[TOKENS][chat_stream first] prompt={usage.prompt_tokens}, "
                f"completion={usage.completion_tokens}, total={usage.total_tokens}",
                flush=True,
            )
        
        response_message = response.choices[0].message
        
        # Function calling이 있으면 실행
        if response_message.tool_calls:
            print(f"[DEBUG] Tool calls detected: {len(response_message.tool_calls)}")
            messages.append(response_message)
            
            for tool_call in response_message.tool_calls:
                function_name = tool_call.function.name
                function_args = json.loads(tool_call.function.arguments)
                
                print(f"[DEBUG] Calling function: {function_name} with args: {function_args}")
                
                # 함수 실행 중임을 알림
                yield f"data: {json.dumps({'function': function_name, 'args': function_args}, ensure_ascii=False)}\n\n"
                
                # 함수 실행
                function_response = await service._execute_function(function_name, function_args)
                
                print(f"[DEBUG] Function response length: {len(str(function_response))}")

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
            
            print(f"[DEBUG] Starting second GPT call for analysis with {len(messages)} messages")
            
            # 함수 결과를 바탕으로 스트리밍 응답
            try:
                stream = await service.client.chat.completions.create(
                    model=service.model,
                    messages=messages,
                    tools=tools,  # tools를 계속 제공
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True,
                    stream_options={"include_usage": True},
                )
            except Exception:
                # openai 라이브러리 버전에 따라 stream_options 미지원일 수 있음
                stream = await service.client.chat.completions.create(
                    model=service.model,
                    messages=messages,
                    tools=tools,  # tools를 계속 제공
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True,
                )
            
            print(f"[DEBUG] Second GPT call started, streaming...")
            
            # 스트리밍 청크 전체 수집 및 로그
            full_stream_content = ""
            stream_chunks = []
            stream_usage = None
            async for chunk in stream:
                if getattr(chunk, "usage", None) is not None:
                    # include_usage=true 일 때 보통 마지막 chunk에 usage가 포함됨
                    stream_usage = chunk.usage
                chunk_dict = {
                    "id": chunk.id if hasattr(chunk, 'id') else None,
                    "model": chunk.model if hasattr(chunk, 'model') else None,
                    "created": chunk.created if hasattr(chunk, 'created') else None,
                    "choices": [
                        {
                            "index": choice.index if hasattr(choice, 'index') else None,
                            "delta": {
                                "role": choice.delta.role if hasattr(choice.delta, 'role') else None,
                                "content": choice.delta.content if hasattr(choice.delta, 'content') else None,
                                "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.delta.tool_calls or [])]
                            } if hasattr(choice, 'delta') else None,
                            "finish_reason": choice.finish_reason if hasattr(choice, 'finish_reason') else None
                        } for choice in chunk.choices
                    ]
                }
                stream_chunks.append(chunk_dict)
                
                if chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    full_stream_content += content
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

            if stream_usage is not None:
                print(
                    f"[TOKENS][chat_stream second stream] prompt={stream_usage.prompt_tokens}, "
                    f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                    flush=True,
                )
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "usage_phase": "chat_stream_second_stream",
                            "usage": {
                                "prompt_tokens": stream_usage.prompt_tokens,
                                "completion_tokens": stream_usage.completion_tokens,
                                "total_tokens": stream_usage.total_tokens,
                            },
                        },
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )
            
            # 스트리밍 완료 후 전체 로그 출력
            print(f"[OPENAI RESPONSE][chat_stream second - streaming] total_chunks={len(stream_chunks)}, full_content_length={len(full_stream_content)}", flush=True)
            print(f"[OPENAI RESPONSE][chat_stream second - full_content] {json.dumps({'content': full_stream_content}, ensure_ascii=False)}", flush=True)
            print(f"[OPENAI RESPONSE][chat_stream second - chunks] {json.dumps(stream_chunks, ensure_ascii=False, indent=2)}", flush=True)
            
            print(f"[DEBUG] Streaming completed")
        else:
            # Function calling 없이 바로 스트리밍
            try:
                stream = await service.client.chat.completions.create(
                    model=service.model,
                    messages=messages,
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True,
                    stream_options={"include_usage": True},
                )
            except Exception:
                stream = await service.client.chat.completions.create(
                    model=service.model,
                    messages=messages,
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True,
                )
            
            # 스트리밍 청크 전체 수집 및 로그
            full_stream_content = ""
            stream_chunks = []
            stream_usage = None
            async for chunk in stream:
                if getattr(chunk, "usage", None) is not None:
                    stream_usage = chunk.usage
                chunk_dict = {
                    "id": chunk.id if hasattr(chunk, 'id') else None,
                    "model": chunk.model if hasattr(chunk, 'model') else None,
                    "created": chunk.created if hasattr(chunk, 'created') else None,
                    "choices": [
                        {
                            "index": choice.index if hasattr(choice, 'index') else None,
                            "delta": {
                                "role": choice.delta.role if hasattr(choice.delta, 'role') else None,
                                "content": choice.delta.content if hasattr(choice.delta, 'content') else None,
                                "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.delta.tool_calls or [])]
                            } if hasattr(choice, 'delta') else None,
                            "finish_reason": choice.finish_reason if hasattr(choice, 'finish_reason') else None
                        } for choice in chunk.choices
                    ]
                }
                stream_chunks.append(chunk_dict)
                
                if chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    full_stream_content += content
                    yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

            if stream_usage is not None:
                print(
                    f"[TOKENS][chat_stream stream] prompt={stream_usage.prompt_tokens}, "
                    f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                    flush=True,
                )
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "usage_phase": "chat_stream_stream",
                            "usage": {
                                "prompt_tokens": stream_usage.prompt_tokens,
                                "completion_tokens": stream_usage.completion_tokens,
                                "total_tokens": stream_usage.total_tokens,
                            },
                        },
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )
            
            # 스트리밍 완료 후 전체 로그 출력
            print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - streaming] total_chunks={len(stream_chunks)}, full_content_length={len(full_stream_content)}", flush=True)
            print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - full_content] {json.dumps({'content': full_stream_content}, ensure_ascii=False)}", flush=True)
            print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - chunks] {json.dumps(stream_chunks, ensure_ascii=False, indent=2)}", flush=True)
        
        yield "data: [DONE]\n\n"
    
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"

async def session_chat_stream(
    service: "AIService",
    session_id: str,
    message: str,
    *,
    system_prompt_override: Optional[str] = None,
    tool_filter: Optional[Callable[[list], list]] = None,
    extra_context_block: Optional[str] = None,
    title_prefix: Optional[str] = None,
    audit_actor: Optional[dict] = None,
    audit_http: Optional[dict] = None,
):
    """세션 기반 AI 챗봇 (스트리밍 + 세션 관리 + Tool Context).

    확장점 4개(모두 선택적, 기본 None 은 기존 동작):
    - system_prompt_override: 시스템 프롬프트를 대체 (ex. 플로팅 어시스턴트)
    - tool_filter: tool 목록에 추가 필터 적용 (ex. READONLY 화이트리스트)
    - extra_context_block: language directive 뒤에 추가 system 메시지 주입
      (ex. 플로팅 위젯의 page_context 스냅샷)
    - title_prefix: 자동 세션 제목 생성 시 앞에 붙이는 prefix (ex. "[플로팅] ")

    audit (선택):
    - audit_actor: { "user_id": str, "email": str } — 누가 요청했는지
    - audit_http: { "ip": str, "user_agent": str, "request_id": str, "path": str }
      → ai.chat.send / ai.tool.call 메타데이터 audit 기록
    """
    from app.database import get_db_service
    from app.services.audit_writer import write_audit
    # ai_service.py 에 정의된 클래스들 — 함수 안 lazy import 로 순환 회피
    from app.services.ai_service import TTLCache, ToolContext

    try:
        db = await get_db_service()
        
        # 세션 확인
        session = await db.get_session(session_id)
        if not session:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Session not found'})}\n\n"
            return
        
        # 사용자 메시지 저장
        await db.add_message(session_id, "user", message)

        # audit: ai.chat.send (본문 저장 안 함 — 메시지는 messages 테이블에 별도 보관)
        if audit_actor:
            await write_audit(
                action='ai.chat.send',
                actor_user_id=audit_actor.get('user_id'),
                actor_email=audit_actor.get('email'),
                target_type='session',
                target_id=session_id,
                after={
                    'session_id': session_id,
                    'message_length': len(message or ''),
                },
                request_ip=(audit_http or {}).get('ip'),
                user_agent=(audit_http or {}).get('user_agent'),
                request_id=(audit_http or {}).get('request_id'),
                path=(audit_http or {}).get('path'),
            )

        # 대화 히스토리 가져오기
        messages_history = await db.get_messages(session_id)

        # GPT 메시지 형식으로 변환
        # 👉 토큰 과사용을 막기 위해 user/assistant 히스토리를 최근 N개만 사용
        MAX_HISTORY_MESSAGES = 10  # user/assistant 메시지 기준 (약 5턴)
        history_for_model = [
            msg for msg in messages_history
            if msg.role in ["user", "assistant"]
        ]
        recent_history = history_for_model[-MAX_HISTORY_MESSAGES:]

        messages = [{
            "role": "system",
            "content": system_prompt_override or SYSTEM_MESSAGE,
        }]
        for msg in recent_history:
            messages.append({
                "role": msg.role,
                "content": service._sanitize_history_content(msg.role, msg.content),
            })
        # Inject language directive AFTER history so it wins over Korean-biased prompt
        # and any prior Korean conversation turns.
        messages.append({
            "role": "system",
            "content": service._build_language_directive(message),
        })

        # 확장점: 호출자가 넘긴 추가 system 블록 (ex. 플로팅 page_context)
        if extra_context_block:
            messages.append({
                "role": "system",
                "content": extra_context_block,
            })

        # Tool Context 가져오기 또는 생성
        if session_id not in service.tool_contexts:
            service.tool_contexts[session_id] = ToolContext(session_id)
            # DB에서 컨텍스트 복원
            context_data = await db.get_context(session_id)
            if context_data:
                service.tool_contexts[session_id].state = context_data.state or {}
                restored = context_data.cache or {}
                tc = TTLCache()
                tc.update(restored)
                service.tool_contexts[session_id].cache = tc
        
        tool_context = service.tool_contexts[session_id]
        
        print(f"[DEBUG] Session {session_id}: {len(messages)} messages, context state keys: {list(tool_context.state.keys())}")
        
        # Function definitions
        tools = service._get_tools_definition()
        # YAML/WIDE 요청 시 legacy JSON-only 도구는 제외
        tools = service._filter_tools_for_output_preference(tools, message)
        # 확장점: 호출자가 넘긴 tool filter (ex. READONLY 화이트리스트)
        if tool_filter is not None:
            tools = tool_filter(tools)

        # 모델 정보를 스트림 첫 이벤트로 전송 (브라우저 콘솔에서 확인용)
        yield f"data: {json.dumps({'model_info': {'provider': service.provider, 'model': service.model, 'role': service.user_role}}, ensure_ascii=False)}\n\n"

        # ===== Multi-turn Tool Calling Loop =====
        max_iterations = 10  # 최대 10번까지 tool call 반복 허용
        iteration = 0
        assistant_content = ""
        tool_calls_log = []  # Tool call 정보 저장
        is_write_intent = service._detect_write_intent(message)
        skip_llm = False
        if service.user_role == "read" and is_write_intent:
            skip_llm = True
            assistant_content = "이 요청은 write 전용 작업이라 read 권한으로는 실행할 수 없습니다. 관리자에게 권한을 요청하세요."
            yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
        elif service.user_role == "write" and any(key in message for key in ["exec", "실행", "명령", "k8s_execute_command"]):
            skip_llm = True
            assistant_content = "이 요청은 admin 전용 작업이라 write 권한으로는 실행할 수 없습니다. 관리자에게 권한을 요청하세요."
            yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
        
        while iteration < max_iterations and not skip_llm:
            iteration += 1
            print(f"[DEBUG] Iteration {iteration}/{max_iterations}")
            
            # GPT 호출 (Function Calling)
            print(f"[AI Service] Session Chat API 호출 (Iteration {iteration}) - 요청 모델: {service.model}", flush=True)
            print(f"[DEBUG] Messages count: {len(messages)}, Tools count: {len(tools)}", flush=True)
            
            try:
                _fc_kwargs = dict(
                    model=service.model,
                    messages=messages,
                    tools=tools,
                    temperature=0.7,
                    max_tokens=4096,
                    timeout=60.0,
                    stream=True,
                )
                try:
                    stream = await service.client.chat.completions.create(**_fc_kwargs, tool_choice="auto", stream_options={"include_usage": True})
                except Exception as tc_err:
                    print(f"[WARN] tool_choice='auto' streaming failed ({tc_err}), retrying without it", flush=True)
                    stream = await service.client.chat.completions.create(**_fc_kwargs)

                # --- streaming delta 수집 ---
                collected_tool_calls = {}  # index -> {id, name, arguments}
                stream_content = ""
                stream_usage = None
                last_finish_reason = None

                async for chunk in stream:
                    if getattr(chunk, "usage", None) is not None:
                        stream_usage = chunk.usage
                    if not chunk.choices:
                        continue
                    delta = getattr(chunk.choices[0], "delta", None)
                    if delta is None:
                        continue
                    fr = getattr(chunk.choices[0], "finish_reason", None)
                    if fr:
                        last_finish_reason = fr

                    # 텍스트 content → 즉시 프론트엔드로 스트리밍
                    if delta.content:
                        stream_content += delta.content
                        yield f"data: {json.dumps({'content': delta.content}, ensure_ascii=False)}\n\n"

                    # tool_calls delta 누적
                    if delta.tool_calls:
                        for tc_delta in delta.tool_calls:
                            idx = tc_delta.index
                            if idx not in collected_tool_calls:
                                collected_tool_calls[idx] = {
                                    "id": tc_delta.id or "",
                                    "name": getattr(tc_delta.function, "name", "") or "",
                                    "arguments": "",
                                }
                            if tc_delta.id:
                                collected_tool_calls[idx]["id"] = tc_delta.id
                            if getattr(tc_delta.function, "name", None):
                                collected_tool_calls[idx]["name"] = tc_delta.function.name
                            if getattr(tc_delta.function, "arguments", None):
                                collected_tool_calls[idx]["arguments"] += tc_delta.function.arguments

                # usage 로그
                if stream_usage is not None:
                    print(
                        f"[TOKENS][session_chat iteration {iteration}] prompt={stream_usage.prompt_tokens}, "
                        f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                        flush=True,
                    )
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "usage_phase": f"session_chat_iteration_{iteration}",
                                "usage": {
                                    "prompt_tokens": stream_usage.prompt_tokens,
                                    "completion_tokens": stream_usage.completion_tokens,
                                    "total_tokens": stream_usage.total_tokens,
                                },
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )

            except Exception as api_error:
                print(f"[ERROR] OpenAI API call failed: {api_error}", flush=True)
                yield f"data: {json.dumps({'error': f'OpenAI API 호출 실패: {str(api_error)}'}, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return

            # --- tool call이 있으면 실행 후 다음 iteration ---
            if collected_tool_calls:
                print(f"[DEBUG] Tool calls detected: {len(collected_tool_calls)}")
                # assistant message를 dict로 구성 (OpenAI API 호환)
                tc_list = []
                for idx in sorted(collected_tool_calls.keys()):
                    tc = collected_tool_calls[idx]
                    tc_list.append({
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    })
                assistant_msg = {
                    "role": "assistant",
                    "content": stream_content or None,
                    "tool_calls": tc_list,
                }
                messages.append(assistant_msg)

                for tc_dict in tc_list:
                    function_name = tc_dict["function"]["name"]
                    function_args = json.loads(tc_dict["function"]["arguments"])

                    print(f"[DEBUG] Calling function: {function_name} with args: {function_args}")

                    yield f"data: {json.dumps({'function': function_name, 'args': function_args}, ensure_ascii=False)}\n\n"

                    # H2: a tool that changes the cluster is not run from the
                    # model's call. Record an approval request, tell the user
                    # (SSE) and the model (tool result), and move on.
                    pending_approval_id = None
                    from app.services.tool_whitelists import WRITE_TOOL_NAMES, write_approval_required
                    if function_name in WRITE_TOOL_NAMES and write_approval_required():
                        from app.services.ai import permissions as _perm
                        approval = await db.create_tool_approval(
                            session_id=session_id,
                            user_id=(audit_actor or {}).get('user_id') or session.user_id,
                            user_email=(audit_actor or {}).get('email'),
                            cluster=_perm.effective_cluster(service),
                            tool=function_name,
                            args=function_args if isinstance(function_args, dict) else {},
                        )
                        pending_approval_id = approval.id
                        yield f"data: {json.dumps({'approval_required': approval.id, 'function': function_name, 'args': function_args, 'cluster': approval.cluster, 'expires_at': approval.expires_at.isoformat() + 'Z'}, ensure_ascii=False)}\n\n"
                        if audit_actor:
                            await write_audit(
                                action='ai.tool.approval_requested',
                                actor_user_id=audit_actor.get('user_id'),
                                actor_email=audit_actor.get('email'),
                                target_type='tool',
                                target_id=function_name,
                                namespace=function_args.get('namespace') if isinstance(function_args, dict) else None,
                                after={'session_id': session_id, 'approval_id': approval.id, 'cluster': approval.cluster, 'tool': function_name},
                                request_ip=(audit_http or {}).get('ip'),
                                user_agent=(audit_http or {}).get('user_agent'),
                                request_id=(audit_http or {}).get('request_id'),
                                path=(audit_http or {}).get('path'),
                            )
                        function_response = json.dumps({
                            "status": "pending_approval",
                            "approval_id": approval.id,
                            "message": "This action changes the cluster and is waiting for the user's approval in the chat. Do not call the tool again; tell the user it awaits their approval.",
                        }, ensure_ascii=False)
                    else:
                        function_response = await service._execute_function_with_context(
                            function_name, function_args, tool_context
                        )

                    print(f"[DEBUG] Function response length: {len(str(function_response))}")

                    formatted_result, is_json, is_yaml = formatters._format_tool_result(
                        function_name, function_args, function_response,
                    )
                    display_result = formatters._build_tool_display(
                        function_name, function_args, formatted_result, is_json, is_yaml,
                    )

                    max_preview_len = 2500
                    result_preview = formatted_result[:max_preview_len] + "\n... (truncated) ..." if len(formatted_result) > max_preview_len else formatted_result
                    display_preview = None
                    if display_result is not None:
                        display_preview = display_result[:max_preview_len] + "\n... (truncated) ..." if len(display_result) > max_preview_len else display_result

                    payload = {
                        "function_result": function_name,
                        "result": result_preview,
                        "is_json": is_json,
                        "is_yaml": is_yaml,
                    }
                    if display_preview is not None:
                        payload["display"] = display_preview
                        payload["display_format"] = "kubectl"
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

                    tool_calls_log.append({
                        'function': function_name,
                        'args': function_args,
                        'result': formatted_result,
                        'is_json': is_json,
                        'is_yaml': is_yaml,
                        'display': display_result,
                        'display_format': "kubectl" if display_result is not None else None,
                        # set when the call is parked for approval (H2) — the UI renders the card from this
                        'approval_id': pending_approval_id,
                    })

                    # audit: ai.tool.call (메타데이터만 — args/result 본문은 저장하지 않음)
                    if audit_actor:
                        ns_arg = function_args.get('namespace') if isinstance(function_args, dict) else None
                        target_id_arg = (
                            function_args.get('resource_name')
                            or function_args.get('name')
                            or function_args.get('pod_name')
                        ) if isinstance(function_args, dict) else None
                        target_type_arg = function_args.get('resource_type') if isinstance(function_args, dict) else None
                        await write_audit(
                            action='ai.tool.call',
                            actor_user_id=audit_actor.get('user_id'),
                            actor_email=audit_actor.get('email'),
                            target_type=target_type_arg or 'tool',
                            target_id=target_id_arg or function_name,
                            namespace=ns_arg,
                            after={
                                'session_id': session_id,
                                'tool': function_name,
                                'iteration': iteration,
                                'resource_type': target_type_arg,
                            },
                            request_ip=(audit_http or {}).get('ip'),
                            user_agent=(audit_http or {}).get('user_agent'),
                            request_id=(audit_http or {}).get('request_id'),
                            path=(audit_http or {}).get('path'),
                        )

                    tool_message_content = formatters._truncate_tool_result_for_llm(formatted_result)
                    messages.append({
                        "tool_call_id": tc_dict["id"],
                        "role": "tool",
                        "name": function_name,
                        "content": tool_message_content
                    })

                continue

            # --- tool call 없음 → 텍스트가 이미 스트리밍됨 ---
            else:
                assistant_content = stream_content
                if assistant_content:
                    messages.append({"role": "assistant", "content": assistant_content})

                print(f"[DEBUG] Streaming completed. finish_reason={last_finish_reason}, length={len(assistant_content)}")

                # 길이 제한으로 잘렸다면 이어서 최대 3회까지 추가 스트리밍
                if last_finish_reason == "length":
                    max_continuations = 3
                    for continuation_index in range(1, max_continuations + 1):
                        print(f"[DEBUG] Continuation {continuation_index}/{max_continuations}")
                        messages.append({
                            "role": "user",
                            "content": (
                                "방금 답변이 길이 제한으로 중간에 끊겼습니다. "
                                "바로 이전 출력의 마지막 문장/항목 다음부터 자연스럽게 이어서 작성하세요. "
                                "이미 출력한 내용은 반복하지 마세요."
                            ),
                        })

                        try:
                            cont_stream = await service.client.chat.completions.create(
                                model=service.model, messages=messages,
                                temperature=0.7, max_tokens=4096,
                                stream=True, stream_options={"include_usage": True},
                            )
                        except Exception:
                            cont_stream = await service.client.chat.completions.create(
                                model=service.model, messages=messages,
                                temperature=0.7, max_tokens=4096, stream=True,
                            )

                        continuation_text = ""
                        cont_finish_reason = None
                        async for chunk in cont_stream:
                            if chunk.choices and getattr(chunk.choices[0], "delta", None):
                                delta = chunk.choices[0].delta
                                if delta.content:
                                    continuation_text += delta.content
                                    assistant_content += delta.content
                                    yield f"data: {json.dumps({'content': delta.content}, ensure_ascii=False)}\n\n"
                            if chunk.choices and getattr(chunk.choices[0], "finish_reason", None):
                                cont_finish_reason = chunk.choices[0].finish_reason

                        if continuation_text:
                            messages.append({"role": "assistant", "content": continuation_text})
                        if cont_finish_reason != "length":
                            break

                break
        
        # Max iterations 도달
        if iteration >= max_iterations and not assistant_content:
            print(f"[WARNING] Max iterations ({max_iterations}) reached without final response")
            assistant_content = "죄송합니다. 정보 수집 중 최대 반복 횟수에 도달했습니다. 더 구체적인 질문으로 다시 시도해주세요."
            yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
        
        print(f"[DEBUG] Preparing to save message. assistant_content length: {len(assistant_content)}, tool_calls: {len(tool_calls_log)}")
        
        # Tool call 정보를 포함한 전체 메시지 생성 (KAgent 스타일)
        full_message = ""
        if tool_calls_log:
            for tc in tool_calls_log:
                # Arguments 섹션
                if tc['args']:
                    args_json = json.dumps(tc['args'], indent=2, ensure_ascii=False)
                    args_section = f"""<details>
<summary><strong>📋 Arguments</strong></summary>

```json
{args_json}
```

</details>"""
                else:
                    args_section = '<p><strong>📋 Arguments:</strong> No arguments</p>'
                
                # Results 섹션 - 실제 tool 실행 결과
                result_preview = tc.get('display') or tc.get('result', 'No result')
                is_json = tc.get('is_json', False)
                is_yaml = tc.get('is_yaml', False)
                if tc.get('display'):
                    code_fence = "```"
                elif is_yaml:
                    code_fence = "```yaml"
                else:
                    code_fence = "```json" if is_json else "```"
                
                results_section = f"""<details>
<summary><strong>📊 Results</strong></summary>

{code_fence}
{result_preview}
```

</details>"""
                
                full_message += f"""<details>
<summary>🔧 <strong>{tc['function']}</strong></summary>

{args_section}

{results_section}

</details>

"""
        full_message += assistant_content
        
        print(f"[DEBUG] Full message length: {len(full_message)}")
        print(f"[DEBUG] Full message preview: {full_message[:200]}...")
        
        # Assistant 메시지 저장 (tool call 정보 포함 - 전체 결과)
        await db.add_message(session_id, "assistant", full_message, tool_calls=tool_calls_log or None)
        print(f"[DEBUG] Message saved to DB")
        
        # Tool Context를 DB에 저장
        await db.update_context(
            session_id,
            state=tool_context.state,
            cache=tool_context.cache
        )
        
        # 세션 제목 자동 생성 (첫 메시지인 경우)
        if len(messages_history) <= 1:  # 시스템 메시지 + 첫 사용자 메시지
            title = message[:50] + "..." if len(message) > 50 else message
            if title_prefix:
                title = title_prefix + title
            await db.update_session_title(session_id, title)
        
        yield "data: [DONE]\n\n"
    
    except Exception as e:
        print(f"[ERROR] Session chat error: {e}")
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
