"""
AI 트러블슈팅 서비스
"""
from openai import AsyncOpenAI
from typing import List, Dict, Optional
import re
import json
import sys
from app.config import settings
from app.models.ai import (
    LogAnalysisRequest,
    LogAnalysisResponse,
    TroubleshootRequest,
    TroubleshootResponse,
    ChatRequest,
    ChatResponse,
    ErrorPattern,
    SeverityLevel
)
from app.services.k8s_service import K8sService


class ToolContext:
    """Tool 실행 컨텍스트"""
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.state = {}  # 실행 상태
        self.cache = {}  # 결과 캐시


class AIService:
    """AI 트러블슈팅 서비스"""
    
    def __init__(self):
        """OpenAI 클라이언트 초기화"""
        self.client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        self.model = settings.OPENAI_MODEL
        self.k8s_service = K8sService()
        self.tool_contexts: Dict[str, ToolContext] = {}  # {session_id: ToolContext}
        print(f"[AI Service] 초기화 완료 - 사용 모델: {self.model}", flush=True)
    
    async def analyze_logs(self, request: LogAnalysisRequest) -> LogAnalysisResponse:
        """로그 분석"""
        
        # 에러 패턴 추출
        error_patterns = self._extract_error_patterns(request.logs)
        
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
            print(f"[AI Service] Analyze Logs API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 전문가이자 DevOps 엔지니어입니다. 로그를 분석하고 문제를 해결하는 데 도움을 줍니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )
            print(f"[AI Service] Analyze Logs API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            import json
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
    
    async def troubleshoot(self, request: TroubleshootRequest) -> TroubleshootResponse:
        """종합 트러블슈팅"""
        
        # 리소스 정보 수집
        context = await self._gather_resource_context(request)
        
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
            print(f"[AI Service] Troubleshoot API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 트러블슈팅 전문가입니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )
            print(f"[AI Service] Troubleshoot API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            import json
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
    
    async def chat(self, request: ChatRequest) -> ChatResponse:
        """AI 챗봇 with Function Calling"""
        
        # 시스템 메시지
        system_message = """
당신은 Kubernetes 클러스터를 관리하는 AI Agent입니다.
사용자의 질문에 답하기 위해 필요한 경우 Kubernetes API를 직접 호출할 수 있습니다.
실시간 클러스터 정보를 조회하여 정확한 답변을 제공하세요.
"""
        
        # 메시지 변환
        messages = [{"role": "system", "content": system_message}]
        for msg in request.messages:
            messages.append({"role": msg.role, "content": msg.content})
        
        # 컨텍스트 추가
        if request.context:
            context_str = f"\n\n현재 컨텍스트:\n{request.context}"
            messages[-1]["content"] += context_str
        
        # Function definitions
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_namespaces",
                    "description": "클러스터의 모든 네임스페이스 목록을 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pods",
                    "description": "특정 네임스페이스의 Pod 목록과 상태를 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {
                                "type": "string",
                                "description": "네임스페이스 이름 (예: default, kube-system)"
                            }
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_deployments",
                    "description": "특정 네임스페이스의 Deployment 목록과 상태를 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {
                                "type": "string",
                                "description": "네임스페이스 이름"
                            }
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_services",
                    "description": "특정 네임스페이스의 Service 목록을 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {
                                "type": "string",
                                "description": "네임스페이스 이름"
                            }
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_logs",
                    "description": "특정 Pod의 로그를 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"},
                            "pod_name": {"type": "string", "description": "Pod 이름"},
                            "tail_lines": {"type": "integer", "description": "마지막 N줄 (기본값: 50)"}
                        },
                        "required": ["namespace", "pod_name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_cluster_overview",
                    "description": "클러스터 전체 개요 (네임스페이스, Pod, Service 등의 총 개수)를 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]
        
        try:
            # 첫 번째 GPT 호출 (function calling 포함)
            print(f"[AI Service] Chat API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7
            )
            print(f"[AI Service] Chat API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            response_message = response.choices[0].message
            tool_calls = response_message.tool_calls
            
            # Function calling이 있으면 실행
            if tool_calls:
                messages.append(response_message)
                
                for tool_call in tool_calls:
                    function_name = tool_call.function.name
                    function_args = eval(tool_call.function.arguments)
                    
                    # 함수 실행
                    function_response = await self._execute_function(function_name, function_args)
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": str(function_response)
                    })
                
                # 함수 결과를 바탕으로 최종 답변 생성
                print(f"[AI Service] Chat API 두 번째 호출 - 요청 모델: {self.model}", flush=True)
                second_response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=0.7
                )
                print(f"[AI Service] Chat API 두 번째 응답 - 실제 사용 모델: {second_response.model}", flush=True)
                
                message = second_response.choices[0].message.content
            else:
                message = response_message.content
            
            suggestions = self._extract_suggestions(message)
            
            return ChatResponse(
                message=message,
                suggestions=suggestions,
                actions=[]
            )
        except Exception as e:
            raise Exception(f"Chat failed: {e}")
    
    async def explain_resource(self, resource_type: str, resource_yaml: str) -> str:
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
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 리소스 설정 전문가입니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5
            )
            
            return response.choices[0].message.content
        except Exception as e:
            raise Exception(f"Resource explanation failed: {e}")
    
    async def suggest_optimization(self, namespace: str) -> List[str]:
        """리소스 최적화 제안"""
        
        # 네임스페이스의 리소스 정보 수집
        deployments = await self.k8s_service.get_deployments(namespace)
        pods = await self.k8s_service.get_pods(namespace)
        
        context = f"""
Namespace: {namespace}
Deployments: {len(deployments)}
Pods: {len(pods)}

Deployment 상세:
"""
        for deploy in deployments[:5]:  # 처음 5개만
            context += f"\n- {deploy.name}: {deploy.replicas} replicas, image: {deploy.image}"
        
        prompt = f"""
다음 Kubernetes 네임스페이스의 리소스 최적화 방안을 제안해주세요:

{context}

다음 관점에서 분석해주세요:
1. 리소스 요청/제한 설정
2. 레플리카 수 적정성
3. 이미지 최적화
4. 비용 절감 방안
5. 성능 개선 방안

구체적이고 실행 가능한 제안을 리스트로 제공해주세요.
"""
        
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 리소스 최적화 전문가입니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5
            )
            
            content = response.choices[0].message.content
            # 제안을 리스트로 파싱
            suggestions = [line.strip() for line in content.split('\n') if line.strip() and (line.strip().startswith('-') or line.strip().startswith('•'))]
            
            return suggestions if suggestions else [content]
        except Exception as e:
            raise Exception(f"Optimization suggestion failed: {e}")
    
    def _extract_error_patterns(self, logs: str) -> List[ErrorPattern]:
        """로그에서 에러 패턴 추출"""
        patterns = []
        
        # 일반적인 에러 패턴
        error_keywords = [
            (r'ERROR|Error|error', SeverityLevel.HIGH),
            (r'FATAL|Fatal|fatal', SeverityLevel.CRITICAL),
            (r'WARN|Warning|warning', SeverityLevel.MEDIUM),
            (r'Exception|exception', SeverityLevel.HIGH),
            (r'Failed|failed|failure', SeverityLevel.HIGH),
            (r'OOMKilled', SeverityLevel.CRITICAL),
            (r'CrashLoopBackOff', SeverityLevel.CRITICAL),
        ]
        
        for pattern, severity in error_keywords:
            matches = re.findall(pattern, logs)
            if matches:
                patterns.append(ErrorPattern(
                    pattern=pattern,
                    severity=severity,
                    occurrences=len(matches),
                    first_seen=None,
                    last_seen=None
                ))
        
        return patterns
    
    async def _gather_resource_context(self, request: TroubleshootRequest) -> str:
        """리소스 컨텍스트 수집"""
        context = ""
        
        try:
            if request.resource_type.lower() == "pod":
                pods = await self.k8s_service.get_pods(request.namespace)
                pod = next((p for p in pods if p.name == request.resource_name), None)
                if pod:
                    context += f"Pod Status: {pod.status}\n"
                    context += f"Phase: {pod.phase}\n"
                    context += f"Restart Count: {pod.restart_count}\n"
                    context += f"Node: {pod.node_name}\n"
                
                if request.include_logs:
                    logs = await self.k8s_service.get_pod_logs(
                        request.namespace,
                        request.resource_name,
                        tail_lines=50
                    )
                    context += f"\nRecent Logs:\n{logs}\n"
            
            if request.include_events:
                events = await self.k8s_service.get_events(
                    request.namespace,
                    request.resource_name
                )
                if events:
                    context += "\nRecent Events:\n"
                    for event in events[:5]:
                        context += f"- [{event['type']}] {event['reason']}: {event['message']}\n"
        
        except Exception as e:
            context += f"\nError gathering context: {e}\n"
        
        return context
    
    async def chat_stream(self, request: ChatRequest):
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
- `get_namespaces`: 클러스터의 모든 네임스페이스 조회. 항상 먼저 사용하여 클러스터 구조 파악
- `get_pods`: 특정 네임스페이스의 Pod 목록 조회. Pod 상태, 재시작 횟수, 준비 상태 확인
- `get_deployments`: Deployment 목록 조회. 배포 상태 및 레플리카 확인
- `get_services`: Service 목록 조회. 서비스 엔드포인트 및 포트 확인
- `get_node_list`: 클러스터의 노드 목록 조회. 노드 상태, 리소스 용량 확인
- `get_pod_logs`: 특정 Pod의 로그 조회. 에러 메시지 및 스택 트레이스 분석
- `describe_pod`: Pod의 상세 정보 조회. 이벤트, 조건, 구성 확인
- `describe_deployment`: Deployment의 상세 정보 조회
- `describe_service`: Service의 상세 정보 조회
- `describe_node`: Node의 상세 정보 조회
- `get_events`: 리소스와 관련된 이벤트 조회. 최근 발생한 문제 파악
- `get_resource_top`: 리소스 사용량 (CPU, Memory) 조회. 성능 병목 지점 식별

## 도구 사용 원칙

**매우 중요**: 사용자가 질문을 하면, **반드시 먼저 도구를 사용하여 실제 클러스터 상태를 확인**하세요. 절대 추측하지 마세요.

1. **항상 도구를 적극적으로 사용**: 
   - 사용자가 클러스터에 대해 질문하면, 관련 도구를 즉시 호출하세요
   - 일반적인 설명보다 실제 데이터를 우선시하세요

2. **구체적인 정보 수집 예시**: 
   - "네임스페이스가 뭐가 있어?" → 즉시 `get_namespaces` 호출
   - "Pod 상태 확인해줘" → 즉시 `get_pods` 호출
   - "Failed Pod 있어?" → `get_pods` 호출 후 상태 분석, 발견 시 `describe_pod` 및 `get_pod_logs` 추가 호출
   - "리소스 많이 쓰는 Pod는?" → `get_resource_top` 호출
   - "죽어 있는 Pod들 알려줘" → 모든 네임스페이스에 대해 `get_pods` 호출 후 NotReady, Error, CrashLoopBackOff 상태 필터링

3. **문제 발견 시 추가 조사**:
   - Pod 문제 발견 → `describe_pod`, `get_pod_logs`, `get_events` 순차 호출
   - 노드 문제 발견 → `get_node_list`, `describe_node` 호출
   - 재시작이 많은 Pod → `get_pod_logs`로 크래시 원인 파악

4. **컨텍스트 기억**: 이전 대화에서 수집한 정보를 기억하고 활용하세요

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

## 언어

**중요**: 모든 응답은 **반드시 한국어로** 작성해야 합니다.
- 기술 용어는 영어 원문을 병기할 수 있습니다 (예: "파드(Pod)")
- 명령어와 코드는 그대로 유지
- 분석, 설명, 권장사항은 모두 한국어로 작성
- 친근하면서도 전문적인 톤 유지

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
                    "name": "get_namespaces",
                    "description": "클러스터의 모든 네임스페이스 목록을 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pods",
                    "description": "특정 네임스페이스의 Pod 목록과 상태를 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_deployments",
                    "description": "특정 네임스페이스의 Deployment 목록과 상태를 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
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
                    "name": "describe_pod",
                    "description": "특정 Pod의 상세 정보를 조회합니다 (kubectl describe pod와 동일). 컨테이너 상태, 이벤트, 조건 등을 포함합니다.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"},
                            "name": {"type": "string", "description": "Pod 이름"}
                        },
                        "required": ["namespace", "name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_deployment",
                    "description": "특정 Deployment의 상세 정보를 조회합니다 (kubectl describe deployment와 동일)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"},
                            "name": {"type": "string", "description": "Deployment 이름"}
                        },
                        "required": ["namespace", "name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_service",
                    "description": "특정 Service의 상세 정보를 조회합니다 (kubectl describe service와 동일)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"},
                            "name": {"type": "string", "description": "Service 이름"}
                        },
                        "required": ["namespace", "name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_logs",
                    "description": "특정 Pod의 로그를 조회합니다 (kubectl logs와 동일)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"},
                            "pod_name": {"type": "string", "description": "Pod 이름"},
                            "tail_lines": {"type": "integer", "description": "마지막 N줄만 조회 (기본값: 100)"}
                        },
                        "required": ["namespace", "pod_name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_services",
                    "description": "특정 네임스페이스의 Service 목록을 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_events",
                    "description": "특정 네임스페이스의 이벤트를 조회합니다 (kubectl get events와 동일)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_list",
                    "description": "클러스터의 모든 노드 목록을 조회합니다 (kubectl get nodes와 동일)",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_node",
                    "description": "특정 노드의 상세 정보를 조회합니다 (kubectl describe node와 동일)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "노드 이름"}
                        },
                        "required": ["name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pvcs",
                    "description": "PersistentVolumeClaim 목록을 조회합니다",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름 (선택사항, 없으면 전체 조회)"}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pvs",
                    "description": "PersistentVolume 목록을 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]
        
        try:
            # 첫 번째 호출 (function calling 체크)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7
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
                    function_response = await self._execute_function(function_name, function_args)
                    
                    print(f"[DEBUG] Function response length: {len(str(function_response))}")
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": str(function_response)
                    })
                
                print(f"[DEBUG] Starting second GPT call for analysis with {len(messages)} messages")
                
                # 함수 결과를 바탕으로 스트리밍 응답
                stream = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    tools=tools,  # tools를 계속 제공
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True
                )
                
                print(f"[DEBUG] Second GPT call started, streaming...")
                
                async for chunk in stream:
                    if chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
                
                print(f"[DEBUG] Streaming completed")
            else:
                # Function calling 없이 바로 스트리밍
                stream = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=0.8,
                    max_tokens=2000,
                    stream=True
                )
                
                async for chunk in stream:
                    if chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    
    async def _execute_function(self, function_name: str, function_args: dict):
        """Function calling 실행"""
        import json
        
        try:
            print(f"[DEBUG] Executing function: {function_name} with args: {function_args}")
            
            if function_name == "get_namespaces":
                namespaces = await self.k8s_service.get_namespaces()
                result = json.dumps([{"name": ns.name, "status": ns.status} for ns in namespaces], ensure_ascii=False)
                print(f"[DEBUG] get_namespaces result: {result[:200]}")
                return result
            
            elif function_name == "get_pods":
                pods = await self.k8s_service.get_pods(function_args["namespace"])
                result = json.dumps([{
                    "name": pod.name,
                    "status": pod.status,
                    "phase": pod.phase,
                    "restart_count": pod.restart_count
                } for pod in pods], ensure_ascii=False)
                print(f"[DEBUG] get_pods result: {result[:200]}")
                return result
            
            elif function_name == "get_deployments":
                deployments = await self.k8s_service.get_deployments(function_args["namespace"])
                return json.dumps([{
                    "name": deploy.name,
                    "replicas": deploy.replicas,
                    "ready_replicas": deploy.ready_replicas,
                    "status": deploy.status
                } for deploy in deployments], ensure_ascii=False)
            
            elif function_name == "get_services":
                services = await self.k8s_service.get_services(function_args["namespace"])
                return json.dumps([{
                    "name": svc.name,
                    "type": svc.type,
                    "cluster_ip": svc.cluster_ip
                } for svc in services], ensure_ascii=False)
            
            elif function_name == "get_pod_logs":
                logs = await self.k8s_service.get_pod_logs(
                    function_args["namespace"],
                    function_args["pod_name"],
                    tail_lines=function_args.get("tail_lines", 50)
                )
                return logs
            
            elif function_name == "get_cluster_overview":
                overview = await self.k8s_service.get_cluster_overview()
                return json.dumps({
                    "total_namespaces": overview.total_namespaces,
                    "total_pods": overview.total_pods,
                    "total_services": overview.total_services,
                    "total_deployments": overview.total_deployments,
                    "pod_status": overview.pod_status,
                    "node_count": overview.node_count
                }, ensure_ascii=False)
            
            elif function_name == "describe_pod":
                result = await self.k8s_service.describe_pod(
                    function_args["namespace"],
                    function_args["name"]
                )
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "describe_deployment":
                result = await self.k8s_service.describe_deployment(
                    function_args["namespace"],
                    function_args["name"]
                )
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "describe_service":
                result = await self.k8s_service.describe_service(
                    function_args["namespace"],
                    function_args["name"]
                )
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "get_events":
                events = await self.k8s_service.get_events(function_args["namespace"])
                return json.dumps([{
                    "type": event["type"],
                    "reason": event["reason"],
                    "message": event["message"],
                    "count": event["count"]
                } for event in events], ensure_ascii=False)
            
            elif function_name == "get_node_list":
                nodes = await self.k8s_service.get_node_list()
                return json.dumps(nodes, ensure_ascii=False)
            
            elif function_name == "describe_node":
                result = await self.k8s_service.describe_node(function_args["name"])
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "get_pvcs":
                namespace = function_args.get("namespace")
                pvcs = await self.k8s_service.get_pvcs(namespace) if namespace else await self.k8s_service.get_pvcs()
                return json.dumps([{
                    "name": pvc.name,
                    "namespace": pvc.namespace,
                    "status": pvc.status,
                    "capacity": pvc.capacity
                } for pvc in pvcs], ensure_ascii=False)
            
            elif function_name == "get_pvs":
                pvs = await self.k8s_service.get_pvs()
                return json.dumps([{
                    "name": pv.name,
                    "capacity": pv.capacity,
                    "status": pv.status
                } for pv in pvs], ensure_ascii=False)
            
            else:
                return json.dumps({"error": f"Unknown function: {function_name}"})
        
        except Exception as e:
            error_msg = f"Error in {function_name}: {str(e)}"
            print(f"[DEBUG] {error_msg}")
            return json.dumps({"error": error_msg}, ensure_ascii=False)
    
    def _extract_suggestions(self, message: str) -> List[str]:
        """메시지에서 제안 추출"""
        suggestions = []
        
        # "다음을 시도해보세요:", "권장사항:" 등의 패턴 찾기
        lines = message.split('\n')
        in_suggestion_block = False
        
        for line in lines:
            if any(keyword in line.lower() for keyword in ['시도', '권장', '제안', 'try', 'recommend', 'suggest']):
                in_suggestion_block = True
                continue
            
            if in_suggestion_block and line.strip().startswith(('-', '•', '*', '1.', '2.', '3.')):
                suggestions.append(line.strip().lstrip('-•*123456789. '))
        
        return suggestions[:5]  # 최대 5개
    
    async def session_chat_stream(self, session_id: str, message: str):
        """세션 기반 AI 챗봇 (스트리밍 + 세션 관리 + Tool Context)"""
        from app.database import get_db_service
        
        try:
            db = await get_db_service()
            
            # 세션 확인
            session = await db.get_session(session_id)
            if not session:
                yield f"data: {json.dumps({'type': 'error', 'content': 'Session not found'})}\n\n"
                return
            
            # 사용자 메시지 저장
            await db.add_message(session_id, "user", message)
            
            # 대화 히스토리 가져오기
            messages_history = await db.get_messages(session_id)
            
            # GPT 메시지 형식으로 변환
            messages = [{"role": "system", "content": self._get_system_message()}]
            for msg in messages_history:
                if msg.role in ["user", "assistant"]:
                    messages.append({"role": msg.role, "content": msg.content})
            
            # Tool Context 가져오기 또는 생성
            if session_id not in self.tool_contexts:
                self.tool_contexts[session_id] = ToolContext(session_id)
                # DB에서 컨텍스트 복원
                context_data = await db.get_context(session_id)
                if context_data:
                    self.tool_contexts[session_id].state = context_data.state or {}
                    self.tool_contexts[session_id].cache = context_data.cache or {}
            
            tool_context = self.tool_contexts[session_id]
            
            print(f"[DEBUG] Session {session_id}: {len(messages)} messages, context state keys: {list(tool_context.state.keys())}")
            
            # Function definitions
            tools = self._get_tools_definition()
            
            # ===== Multi-turn Tool Calling Loop =====
            max_iterations = 5  # 최대 5번까지 tool call 반복 허용
            iteration = 0
            assistant_content = ""
            tool_calls_log = []  # Tool call 정보 저장
            
            while iteration < max_iterations:
                iteration += 1
                print(f"[DEBUG] Iteration {iteration}/{max_iterations}")
                
                # GPT 호출 (Function Calling)
                print(f"[AI Service] Session Chat API 호출 (Iteration {iteration}) - 요청 모델: {self.model}", flush=True)
                response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    tools=tools,
                    tool_choice="auto",
                    temperature=0.7,
                    max_tokens=1000  # 토큰 제한
                )
                print(f"[AI Service] Session Chat API 응답 (Iteration {iteration}) - 실제 사용 모델: {response.model}", flush=True)
                
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
                        
                        # 함수 실행 (Tool Context 전달)
                        function_response = await self._execute_function_with_context(
                            function_name,
                            function_args,
                            tool_context
                        )
                        
                        print(f"[DEBUG] Function response length: {len(str(function_response))}")
                        
                        # 결과 미리보기 (너무 길면 잘라서 전송)
                        result_preview = str(function_response)[:1000]  # 프론트엔드로는 1000자만
                        
                        # Function 결과를 프론트엔드로 전송 (스트리밍) - 실행 후
                        yield f"data: {json.dumps({'function_result': function_name, 'result': result_preview}, ensure_ascii=False)}\n\n"
                        
                        # Tool call 정보 + 실행 결과 저장
                        tool_calls_log.append({
                            'function': function_name, 
                            'args': function_args,
                            'result': str(function_response)[:2000]  # 결과는 처음 2000자만 저장
                        })
                        
                        messages.append({
                            "tool_call_id": tool_call.id,
                            "role": "tool",
                            "name": function_name,
                            "content": str(function_response)
                        })
                    
                    # 다음 iteration으로 계속
                    continue
                
                # Tool call이 없으면 최종 텍스트 응답 (스트리밍)
                else:
                    print(f"[DEBUG] No tool calls, generating final response (streaming)")
                    
                    # 항상 스트리밍 모드로 최종 응답 생성
                    messages.append(response_message)
                    print(f"[AI Service] Session Chat 스트리밍 API 호출 - 요청 모델: {self.model}", flush=True)
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        temperature=0.7,
                        max_tokens=800,  # 토큰 제한 (간결한 답변)
                        stream=True
                    )
                    
                    print(f"[DEBUG] Streaming final response...")
                    async for chunk in stream:
                        if chunk.choices[0].delta.content:
                            content = chunk.choices[0].delta.content
                            assistant_content += content
                            yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"
                    
                    print(f"[DEBUG] Streaming completed, content length: {len(assistant_content)}")
                    
                    # 최종 응답 완료, 루프 종료
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
                    result_preview = tc.get('result', 'No result')
                    if len(result_preview) > 500:
                        result_preview = result_preview[:500] + "...\n\n(결과가 길어서 일부만 표시됩니다)"
                    
                    results_section = f"""<details>
<summary><strong>📊 Results</strong></summary>

```
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
            
            # Assistant 메시지 저장 (tool call 정보 포함)
            await db.add_message(session_id, "assistant", full_message)
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
                await db.update_session_title(session_id, title)
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            print(f"[ERROR] Session chat error: {e}")
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    
    def _get_system_message(self) -> str:
        """시스템 메시지 반환 (KAgent 스타일)"""
        return """# Kubernetes AI Agent System Prompt

당신은 **KubeAssist**입니다. Kubernetes 트러블슈팅 및 운영에 특화된 고급 AI 에이전트입니다.

## 핵심 역량

- **전문 Kubernetes 지식**: Kubernetes 컴포넌트, 아키텍처, 오케스트레이션 원리, 리소스 관리
- **체계적 트러블슈팅**: 로그, 메트릭, 클러스터 상태를 분석하는 방법론적 접근
- **보안 우선 사고방식**: RBAC, Pod Security Policies, 보안 관행 우선
- **명확한 커뮤니케이션**: 명확하고 간결한 기술 정보 제공
- **안전 지향**: 최소 권한 원칙을 따르고 확인 없이 파괴적 작업 회피

## 운영 가이드라인

### 조사 프로토콜
1. **비침습적 시작**: 더 침습적인 작업 전에 읽기 전용 작업으로 시작
2. **점진적 확대**: 필요한 경우에만 더 상세한 조사로 확대
3. **모든 것을 문서화**: 모든 조사 단계와 작업의 명확한 기록 유지
4. **실행 전 확인**: 변경 사항을 실행하기 전에 잠재적 영향 고려
5. **롤백 계획**: 필요한 경우 변경 사항을 되돌릴 계획 항상 준비

### 문제 해결 프레임워크
1. **초기 평가**: 기본 클러스터 정보 수집, Kubernetes 버전 확인, 노드 상태 확인
2. **문제 분류**: 애플리케이션 문제, 인프라 문제, 성능 문제, 보안 사고, 구성 오류
3. **리소스 분석**: Pod 상태 및 이벤트, 컨테이너 로그, 리소스 메트릭, 네트워크 연결
4. **솔루션 구현**: 여러 솔루션 제안, 위험 평가, 구현 계획, 테스트 전략, 롤백 절차

## 사용 가능한 도구

### 정보 수집 도구
- `get_namespaces`: 클러스터의 모든 네임스페이스 조회. 항상 먼저 사용
- `get_pods`: 특정 네임스페이스의 Pod 목록 조회. Pod 상태, 재시작 횟수 확인
- `get_deployments`: Deployment 목록 조회
- `get_services`: Service 목록 조회
- `get_node_list`: 노드 목록 조회
- `get_pod_logs`: Pod 로그 조회. 에러 메시지 분석
- `describe_pod`: Pod 상세 정보 조회. 이벤트, 조건 확인
- `describe_deployment`: Deployment 상세 정보 조회
- `describe_service`: Service 상세 정보 조회
- `describe_node`: Node 상세 정보 조회
- `get_events`: 이벤트 조회. 최근 발생한 문제 파악
- `get_resource_top`: 리소스 사용량 조회. 성능 병목 지점 식별

## 도구 사용 원칙

**매우 중요**: 사용자가 질문을 하면, **반드시 먼저 도구를 사용하여 실제 클러스터 상태를 확인**하세요. 절대 추측하지 마세요.

1. **항상 도구를 적극적으로 사용**: 
   - 사용자가 클러스터에 대해 질문하면, 관련 도구를 즉시 호출하세요
   - 일반적인 설명보다 실제 데이터를 우선시하세요

2. **구체적인 정보 수집 예시**: 
   - "네임스페이스가 뭐가 있어?" → 즉시 `get_namespaces` 호출
   - "Pod 상태 확인해줘" → 즉시 `get_pods` 호출
   - "Failed Pod 있어?" → `get_pods` 호출 후 상태 분석, 발견 시 `describe_pod` 및 `get_pod_logs` 추가 호출
   - "리소스 많이 쓰는 Pod는?" → `get_resource_top` 호출
   - "죽어 있는 Pod들 알려줘" → 모든 네임스페이스에 대해 `get_pods` 호출 후 NotReady, Error, CrashLoopBackOff 상태 필터링

3. **문제 발견 시 추가 조사**:
   - Pod 문제 발견 → `describe_pod`, `get_pod_logs`, `get_events` 순차 호출
   - 노드 문제 발견 → `get_node_list`, `describe_node` 호출
   - 재시작이 많은 Pod → `get_pod_logs`로 크래시 원인 파악

4. **컨텍스트 기억**: 이전 대화에서 수집한 정보를 기억하고 활용하세요

## 응답 형식

**간결하고 명확하게 답변하세요**:

1. **Tool 결과 분석**: Tool을 호출한 경우, 결과를 간단히 요약하고 핵심 내용만 전달
2. **문제가 있다면**: 문제점과 원인을 명확히 설명
3. **해결 방법**: 필요한 경우 간단한 해결 방법이나 다음 단계 제시

**응답 원칙**:
- ✅ 핵심만 간결하게 전달
- ✅ 불필요한 섹션 구조(## 제목) 사용하지 않기
- ✅ Tool 결과를 자연스럽게 설명
- ✅ 사용자가 물어본 것에만 집중
- ❌ 긴 설명이나 배경 지식은 필요할 때만
- ❌ 형식적인 인사나 불필요한 전문 용어 남발 금지

## 언어

**중요**: 모든 응답은 **반드시 한국어로** 작성해야 합니다.
- 기술 용어는 영어 원문을 병기할 수 있습니다 (예: "파드(Pod)")
- 명령어와 코드는 그대로 유지
- 분석, 설명, 권장사항은 모두 한국어로 작성
- 친근하면서도 전문적인 톤 유지

항상 최소 침습적 접근으로 시작하고, 필요한 경우에만 진단을 확대하세요.

## 구조화된 출력 형식

Tool 결과를 분석한 후 다음 형식으로 응답하세요:

```
## 🔍 분석 요약
[발견한 내용의 간단한 개요]

## ⚠️ 발견된 문제
1. **[문제 유형]**: [구체적인 문제]
   - 심각도: [Critical/High/Medium/Low]
   - 영향받는 리소스: [리소스 이름]
   - 영향: [무엇이 문제인지]

## 🔎 Root Cause
[왜 이런 문제가 발생했는지 상세 설명]

## ✅ Recommended Actions
1. **Immediate Fix**: [명령어 또는 작업]
   ```bash
   kubectl [구체적인 명령어]
   ```
   
2. **Verification**: [How to confirm it's fixed]
   
3. **Prevention**: [How to avoid this in future]

## 📚 Additional Context
[Relevant K8s concepts, best practices, or documentation links]
```

**위 형식은 사용하지 마세요!** 대신 간결하고 자연스럽게 답변하세요.

# Critical Rules

**⚠️ EXTREMELY IMPORTANT - READ CAREFULLY:**

1. **NEVER guess** - Always call functions to get real-time data
2. **Be thorough** - Don't stop at surface-level symptoms
3. **Be concise** - 간결하게 핵심만 전달하세요. 불필요한 구조화된 섹션(## 제목)은 사용하지 마세요
3. **Think ahead** - Anticipate related issues
4. **Explain clearly** - Use analogies for complex concepts
5. **Provide commands** - Give exact kubectl commands to run
6. **Consider impact** - Warn about potential side effects
7. **Remember context** - Reference previous conversation

**🚨 COMPLETION REQUIREMENT:**
- You MUST provide COMPLETE answers with ALL sections filled
- NEVER end your response prematurely
- When you call a tool, you MUST analyze the results thoroughly
- Minimum response length: 3-4 paragraphs with specific details
- Include specific resource names, namespaces, and status information from tool results

# Available Tools (kubectl equivalent)

**Cluster Overview:**
- `get_cluster_overview()` - Overall health snapshot
- `get_namespaces()` - All namespaces
- `get_node_list()` - Node status
- `describe_node(name)` - Node details

**Workload Analysis:**
- `get_pods(namespace)` - Pod list with status
- `describe_pod(namespace, name)` - Full pod details, events, conditions
- `get_pod_logs(namespace, pod_name, tail_lines)` - Container logs
- `get_deployments(namespace)` - Deployment status
- `describe_deployment(namespace, name)` - Deployment details
- `get_services(namespace)` - Service endpoints
- `describe_service(namespace, name)` - Service configuration

**Storage & Config:**
- `get_pvcs(namespace)` - PVC status
- `get_pvs()` - PV availability
- `get_events(namespace)` - Recent events (critical for debugging!)

# Example Workflow

User: "My pod is not starting"

Your thought process:
1. Which namespace? If not specified, ask or check default
2. Get pods → Find the problematic one
3. Describe pod → Check conditions, events
4. Get logs → Look for startup errors
5. Check events → Find scheduling/pulling issues
6. Analyze → Determine root cause
7. Provide solution with commands

# Tone
- Professional but approachable
- Confident but not arrogant
- Patient with beginners
- Detailed with experts
- Always constructive

Remember: You're not just answering questions - you're **solving production problems** and **teaching best practices**.
"""
    
    def _get_tools_definition(self) -> List[Dict]:
        """Tools 정의 반환 (상세한 설명 포함)"""
        return [
            {
                "type": "function",
                "function": {
                    "name": "get_cluster_overview",
                    "description": """Get a comprehensive overview of the entire Kubernetes cluster health.
                    
                    Returns:
                    - Total counts: namespaces, pods, services, deployments, PVCs, PVs
                    - Pod status breakdown (Running, Pending, Failed, etc.)
                    - Node count and cluster version
                    
                    Use this FIRST when user asks about cluster health or wants a general status check.""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_namespaces",
                    "description": """List all namespaces in the cluster with their status.
                    
                    Returns: Array of {name, status}
                    
                    Use when user wants to see available namespaces or explore cluster organization.""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_all_pods",
                    "description": """List ALL pods across ALL namespaces in the cluster with their current status.
                    
                    Returns: Array of {name, namespace, status, phase, restart_count, ready}
                    
                    **USE THIS FIRST** when user asks about:
                    - "죽어 있는 Pod" / "Failed Pods" / "문제 있는 Pod"
                    - Pod status across the entire cluster
                    - Pods with high restart counts
                    - Any cluster-wide Pod investigation
                    
                    This is MORE EFFICIENT than calling get_pods() for each namespace separately.
                    Status values: Running, Pending, Failed, CrashLoopBackOff, ImagePullBackOff, etc.
                    
                    After getting results, filter for problematic pods:
                    - status != "Running"
                    - restart_count > 5
                    - ready != "X/X" (not all containers ready)""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pods",
                    "description": """List all pods in a specific namespace with their current status.
                    
                    Returns: Array of {name, status, phase, restart_count}
                    
                    IMPORTANT: Check restart_count! High values (>5) indicate instability.
                    Status values: Running, Pending, Failed, CrashLoopBackOff, ImagePullBackOff, etc.
                    
                    Use this to identify problematic pods or get workload overview.""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {
                                "type": "string",
                                "description": "Target namespace name (e.g., 'default', 'kube-system')"
                            }
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_pod",
                    "description": """Get detailed information about a specific pod (equivalent to kubectl describe pod).
                    
                    Returns:
                    - Pod metadata (labels, annotations)
                    - Container states (running/waiting/terminated with reasons)
                    - Conditions (PodScheduled, Initialized, Ready, ContainersReady)
                    - Recent events (critical for troubleshooting!)
                    
                    Use this when investigating WHY a pod is failing or not starting.
                    Events often contain the root cause (e.g., ImagePullBackOff, OOMKilled).""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Namespace containing the pod"},
                            "name": {"type": "string", "description": "Exact pod name"}
                        },
                        "required": ["namespace", "name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_logs",
                    "description": """Retrieve container logs from a pod (kubectl logs).
                    
                    Returns: Recent log output (default: last 100 lines)
                    
                    Use this to:
                    - Find application errors or stack traces
                    - Check startup logs for initialization issues
                    - Identify crash reasons
                    
                    Look for: ERROR, FATAL, Exception, panic, segfault, OOM, connection refused.""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Namespace"},
                            "pod_name": {"type": "string", "description": "Pod name"},
                            "tail_lines": {
                                "type": "integer",
                                "description": "Number of recent lines to retrieve (default: 100)"
                            }
                        },
                        "required": ["namespace", "pod_name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_deployments",
                    "description": """List deployments in a namespace with replica status.
                    
                    Returns: Array of {name, replicas, ready_replicas, status}
                    
                    Check if ready_replicas < replicas → indicates deployment issues.""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Namespace"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_deployment",
                    "description": """Get detailed deployment information including rollout status and conditions.
                    
                    Use when investigating deployment failures or rollout issues.""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string"},
                            "name": {"type": "string"}
                        },
                        "required": ["namespace", "name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_services",
                    "description": """List services and their endpoints in a namespace.
                    
                    Use to check service discovery and networking configuration.""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_events",
                    "description": """Get recent Kubernetes events in a namespace.
                    
                    Events are CRITICAL for troubleshooting! They show:
                    - Scheduling failures
                    - Image pull errors
                    - Volume mount issues
                    - Resource constraints
                    - Health check failures
                    
                    ALWAYS check events when investigating problems!""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Namespace to get events from"}
                        },
                        "required": ["namespace"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_list",
                    "description": """List all nodes in the cluster with their status.
                    
                    Check for NotReady nodes or resource pressure.""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "describe_node",
                    "description": """Get detailed node information including capacity, allocatable resources, and conditions.
                    
                    Use to diagnose node-level issues (disk pressure, memory pressure, PID pressure).""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Node name"}
                        },
                        "required": ["name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pvcs",
                    "description": """List PersistentVolumeClaims and their binding status.
                    
                    Check for Pending PVCs (storage provisioning issues).""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Optional namespace filter"}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pvs",
                    "description": """List PersistentVolumes and their availability.
                    
                    Use to check storage capacity and binding issues.""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_metrics",
                    "description": """Get pod resource usage (CPU and memory) - equivalent to 'kubectl top pods'.
                    
                    Use this to:
                    - Check which pods are consuming the most resources
                    - Identify resource-heavy workloads
                    - Diagnose performance issues
                    - Monitor resource utilization""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Optional namespace filter. If not provided, shows all pods across all namespaces."}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_metrics",
                    "description": """Get node resource usage (CPU and memory) - equivalent to 'kubectl top nodes'.
                    
                    Use this to:
                    - Check node resource utilization
                    - Identify nodes under heavy load
                    - Monitor cluster capacity
                    - Diagnose node-level performance issues""",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]
    
    async def _execute_function_with_context(
        self,
        function_name: str,
        function_args: Dict,
        tool_context: ToolContext
    ) -> str:
        """Function 실행 (Tool Context 포함)"""
        import json
        
        try:
            print(f"[DEBUG] Executing {function_name} with context, state keys: {list(tool_context.state.keys())}")
            
            # 캐시 확인
            cache_key = f"{function_name}_{json.dumps(function_args, sort_keys=True)}"
            if cache_key in tool_context.cache:
                print(f"[DEBUG] Cache hit for {cache_key}")
                return tool_context.cache[cache_key]
            
            # 함수 실행
            if function_name == "get_cluster_overview":
                overview = await self.k8s_service.get_cluster_overview()
                result = json.dumps({
                    "total_namespaces": overview.total_namespaces,
                    "total_pods": overview.total_pods,
                    "total_services": overview.total_services,
                    "total_deployments": overview.total_deployments,
                    "pod_status": overview.pod_status,
                    "node_count": overview.node_count
                }, ensure_ascii=False)
            
            elif function_name == "get_namespaces":
                namespaces = await self.k8s_service.get_namespaces()
                result = json.dumps([{"name": ns.name, "status": ns.status} for ns in namespaces], ensure_ascii=False)
                tool_context.state["last_namespaces"] = [ns.name for ns in namespaces]
            
            elif function_name == "get_all_pods":
                pods = await self.k8s_service.get_all_pods()
                result = json.dumps([{
                    "name": pod.name,
                    "namespace": pod.namespace,
                    "status": pod.status,
                    "phase": pod.phase,
                    "restart_count": pod.restart_count,
                    "ready": pod.ready
                } for pod in pods], ensure_ascii=False)
                tool_context.state["last_all_pods_count"] = len(pods)
            
            elif function_name == "get_pods":
                pods = await self.k8s_service.get_pods(function_args["namespace"])
                result = json.dumps([{
                    "name": pod.name,
                    "status": pod.status,
                    "phase": pod.phase,
                    "restart_count": pod.restart_count
                } for pod in pods], ensure_ascii=False)
                tool_context.state["last_namespace"] = function_args["namespace"]
                tool_context.state["last_pods"] = [{"name": pod.name, "status": pod.status} for pod in pods]
            
            elif function_name == "describe_pod":
                result_data = await self.k8s_service.describe_pod(
                    function_args["namespace"],
                    function_args["name"]
                )
                result = json.dumps(result_data, ensure_ascii=False)
                tool_context.state["last_described_pod"] = function_args["name"]
            
            elif function_name == "get_pod_logs":
                logs = await self.k8s_service.get_pod_logs(
                    function_args["namespace"],
                    function_args["pod_name"],
                    tail_lines=function_args.get("tail_lines", 100)
                )
                result = logs
                tool_context.state["last_log_pod"] = function_args["pod_name"]
            
            elif function_name == "get_deployments":
                deployments = await self.k8s_service.get_deployments(function_args["namespace"])
                result = json.dumps([{
                    "name": deploy.name,
                    "replicas": deploy.replicas,
                    "ready_replicas": deploy.ready_replicas,
                    "status": deploy.status
                } for deploy in deployments], ensure_ascii=False)
            
            elif function_name == "describe_deployment":
                result_data = await self.k8s_service.describe_deployment(
                    function_args["namespace"],
                    function_args["name"]
                )
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_services":
                services = await self.k8s_service.get_services(function_args["namespace"])
                result = json.dumps([{
                    "name": svc.name,
                    "type": svc.type,
                    "cluster_ip": svc.cluster_ip
                } for svc in services], ensure_ascii=False)
            
            elif function_name == "describe_service":
                result_data = await self.k8s_service.describe_service(
                    function_args["namespace"],
                    function_args["name"]
                )
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_events":
                events = await self.k8s_service.get_events(function_args["namespace"])
                result = json.dumps([{
                    "type": event["type"],
                    "reason": event["reason"],
                    "message": event["message"],
                    "count": event["count"]
                } for event in events], ensure_ascii=False)
            
            elif function_name == "get_node_list":
                nodes = await self.k8s_service.get_node_list()
                result = json.dumps(nodes, ensure_ascii=False)
            
            elif function_name == "describe_node":
                result_data = await self.k8s_service.describe_node(function_args["name"])
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_pvcs":
                namespace = function_args.get("namespace")
                pvcs = await self.k8s_service.get_pvcs(namespace) if namespace else await self.k8s_service.get_pvcs()
                result = json.dumps([{
                    "name": pvc.name,
                    "namespace": pvc.namespace,
                    "status": pvc.status,
                    "capacity": pvc.capacity
                } for pvc in pvcs], ensure_ascii=False)
            
            elif function_name == "get_pvs":
                pvs = await self.k8s_service.get_pvs()
                result = json.dumps([{
                    "name": pv.name,
                    "capacity": pv.capacity,
                    "status": pv.status
                } for pv in pvs], ensure_ascii=False)
            
            elif function_name == "get_pod_metrics":
                namespace = function_args.get("namespace")
                metrics = await self.k8s_service.get_pod_metrics(namespace)
                result = json.dumps(metrics, ensure_ascii=False)
            
            elif function_name == "get_node_metrics":
                metrics = await self.k8s_service.get_node_metrics()
                result = json.dumps(metrics, ensure_ascii=False)
            
            else:
                return json.dumps({"error": f"Unknown function: {function_name}"})
            
            # 캐시에 저장 (5분 TTL - 실제로는 timestamp 체크 필요)
            tool_context.cache[cache_key] = result
            
            print(f"[DEBUG] Function result cached: {cache_key}")
            return result
        
        except Exception as e:
            error_msg = f"Error in {function_name}: {str(e)}"
            print(f"[DEBUG] {error_msg}")
            return json.dumps({"error": error_msg}, ensure_ascii=False)
