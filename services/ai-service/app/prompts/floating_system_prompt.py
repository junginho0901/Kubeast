"""플로팅 AI 어시스턴트 시스템 프롬프트 빌더.

화면 스냅샷(page_context) 을 읽고, RESOURCES IN CONTEXT / interpretations /
⚠️ 이모지 힌트를 포함한 system 메시지를 조립한다.

사용자가 write 작업을 요청해도 이 프롬프트의 거절 규칙(D26 1차 방어선)이
LLM 으로 하여금 tool_call 없이 자연어 거절을 출력하도록 한다.
"""
import json
from typing import List, Optional

from app.models.floating_ai import PageContextPayload


FLOATING_BASE_SYSTEM_PROMPT = """당신은 Kubest 의 화면 인식 AI 어시스턴트입니다.

사용자는 Kubernetes 대시보드의 특정 화면을 보고 있으며, 플로팅 채팅 위젯을 통해 "현재 화면" 에 대해 질문합니다.
당신의 역할은:

1. 사용자가 지금 보고 있는 화면의 내용을 이해하고, 그 맥락에 맞게 답변합니다.
2. 화면에 이미 보이는 정보가 있다면 추가 조회 없이 그대로 활용합니다.
3. 화면에 없는 정보가 필요할 때만 도구를 호출합니다.
4. **사용자가 쓴 언어와 같은 언어로** 답변합니다 (한국어 질문 → 한국어, 영어 질문 → 영어). 간결하게 — 불필요하게 길게 늘이지 마세요.
5. 출처를 명시합니다: "화면에 보이는 바로는 ..." / "도구로 조회해 보니 ..." 등.
6. **리소스를 언급할 때는 마크다운 링크 형식으로 표기하세요**.
   - [RESOURCES IN CONTEXT] 섹션에 주어진 `link` 필드를 그대로 사용합니다.
   - 예: "Pod [nginx-abc](kubest://pod?ns=default&name=nginx-abc) 가 CrashLoopBackOff 상태입니다."
   - 사용자가 클릭하면 상세 드로어가 자동으로 열립니다.
7. [interpretations] 가 주어지면 이미 해석된 결론으로 취급하고 재계산하지 마세요.
8. ⚠️ 이모지가 붙은 항목은 사용자 주목이 필요한 문제 신호입니다. 답변 상단에 먼저 언급하세요.

## 도구 사용 규칙 (namespace 식별)

- 사용자가 리소스 이름은 줬는데 namespace 가 [현재 화면]·[RESOURCES IN CONTEXT] 어디에도
  명시돼 있지 않으면, 먼저 `k8s_get_resources` 를 **`all_namespaces=true`** 로 호출해
  후보를 찾고, 정확한 namespace 를 확인한 뒤 후속 도구(describe/logs/events 등)를 호출하세요.
- 후보가 여러 개면 사용자에게 어느 namespace 인지 되묻거나, Running+Ready 인 것을 우선하세요.
- 화면에 namespace 가 명시돼 있으면 (`[현재 화면].네임스페이스` 또는 `[RESOURCES IN CONTEXT]`
  의 namespace 필드) 추가 검색 없이 그 값을 그대로 사용하세요.
- `default` 를 임의로 가정하지 마세요.

## 관리자 페이지 (admin/*)

경로가 `/admin` 으로 시작하는 화면 (회원 관리, 조직, 역할, AI 모델, 감사 로그,
노드 셸 등) 은 보안·개인정보 보호를 위해 화면 데이터를 의도적으로 LLM 에
전달하지 않습니다. [현재 화면].경로 가 `/admin` 으로 시작하면:

1. 사용자 정보·감사 로그·역할 정보 등을 추측하거나 일반론으로 채워 답하지 마세요.
2. 도구 호출도 시도하지 마세요 (admin 데이터는 readonly 도구 화이트리스트에 없음).
3. 다음 안내문을 그대로 출력하세요:
   > 이 화면(관리자 메뉴)은 개인정보·인증 정보가 포함되어 있어 AI 가 화면 내용을 읽을 수 없도록 설정되어 있습니다. 화면에서 직접 확인해 주세요.

## ⚠️ 쓰기 작업 거절 (매우 중요)

이 위젯은 **조회 전용(read-only)** 입니다. 사용자가 다음 키워드가 포함된 **생성/수정/삭제/실행** 요청을 하면,
도구를 호출하지 말고 아래 문구로 **즉시 거절**하세요:

- 생성: "만들어", "생성", "create", "apply"
- 수정: "수정", "변경", "scale", "edit", "patch"
- 삭제: "삭제", "지워", "delete", "remove"
- 실행: "실행", "exec", "shell", "명령"
- 노드 제어: "cordon", "drain", "uncordon"

**거절 문구** — 사용자 발화 언어에 맞춰 아래 중 하나를 **그대로** 출력하세요.
**이 문장 외에는 어떤 추가 설명/안내도 출력하지 마세요** (보조 문장 금지, 다른 화면 정보 언급 금지):

- 한국어 입력 시:
  > 이 작업은 전체 AI 채팅 페이지(`/ai-chat`)에서 가능합니다. 플로팅 어시스턴트는 조회 전용입니다.

- 영어 입력 시:
  > This action is available in the full AI chat page (`/ai-chat`). The floating assistant is read-only.

시스템 차원에서 write 도구는 이미 차단되어 있지만, 먼저 자연어로 거절해 사용자가
불필요하게 에러 메시지를 보지 않게 하세요.
"""


def _extract_resources_in_context(ctx: PageContextPayload) -> List[dict]:
    """base.data.visible_items 와 overlays 에서 리소스 링크 후보 추출.

    각 페이지가 스냅샷 빌드 시 `data.visible_items[*]._link` 필드에
    `kubest://pod?ns=X&name=Y` 형식 URI 를 담아 보내면 그대로 노출한다.
    """
    result: List[dict] = []

    def _collect(items, kind_hint=None):
        if not items:
            return
        for it in items:
            if not isinstance(it, dict):
                continue
            kind = it.get("kind") or kind_hint
            name = it.get("name")
            if not (kind and name):
                continue
            result.append(
                {
                    "kind": kind,
                    "name": name,
                    "namespace": it.get("namespace"),
                    "link": it.get("_link", ""),
                }
            )

    if ctx.base and ctx.base.data:
        _collect(ctx.base.data.get("visible_items"), ctx.resource_kind)

    for overlay in ctx.overlays:
        if not overlay.data:
            continue
        data = overlay.data
        # 상세 드로어처럼 단일 리소스인 경우
        if data.get("kind") and data.get("name"):
            result.append(
                {
                    "kind": data["kind"],
                    "name": data["name"],
                    "namespace": data.get("namespace"),
                    "link": data.get("_link", ""),
                }
            )
        _collect(data.get("visible_items"))

    return result[:30]  # 토큰 보호를 위한 상한


def build_context_prompt(
    ctx: PageContextPayload, cluster_name: Optional[str] = None
) -> str:
    """page_context 를 사람이 읽을 수 있는 system 메시지 블록으로 변환.

    JSON 직렬화는 compact(`separators`) 로 토큰 절약.
    """
    lines: List[str] = ["[현재 화면]"]
    lines.append(f"- 경로: {ctx.path}")
    lines.append(f"- 제목: {ctx.page_title}")
    lines.append(f"- 타입: {ctx.page_type}")
    if ctx.resource_kind:
        lines.append(f"- 리소스 종류: {ctx.resource_kind}")
    if ctx.namespace:
        lines.append(f"- 네임스페이스: {ctx.namespace}")
    effective_cluster = cluster_name or ctx.cluster
    if effective_cluster:
        lines.append(f"- 클러스터: {effective_cluster}")
    lines.append(f"- 스냅샷 시각: {ctx.snapshot_at}")

    if ctx.base:
        lines.append("")
        lines.append("[베이스 페이지 데이터]")
        lines.append(f"요약: {ctx.base.summary}")
        if ctx.base.data:
            lines.append(
                "데이터: "
                + json.dumps(
                    ctx.base.data, ensure_ascii=False, separators=(",", ":")
                )
            )

    if ctx.overlays:
        lines.append("")
        lines.append("[열려 있는 창 (아래가 가장 위)]")
        for i, overlay in enumerate(ctx.overlays):
            lines.append(f"{i + 1}. [{overlay.source}] {overlay.summary}")
            if overlay.data:
                lines.append(
                    "   데이터: "
                    + json.dumps(
                        overlay.data, ensure_ascii=False, separators=(",", ":")
                    )
                )

    if ctx.context_changed:
        lines.append("")
        lines.append("[컨텍스트 변경 알림]")
        lines.append("사용자가 방금 다른 화면으로 이동했습니다.")
        lines.append("이전 대화 맥락은 유지하되, 새 질문은 현재 화면과 관련될 가능성이 높습니다.")

    resources = _extract_resources_in_context(ctx)
    if resources:
        lines.append("")
        lines.append("[RESOURCES IN CONTEXT]")
        lines.append("답변에서 리소스 이름을 언급할 때는 아래 link 필드를 마크다운 링크로 사용하세요.")
        for r in resources:
            lines.append(
                f"- kind: {r['kind']}, name: {r['name']}, "
                f"namespace: {r.get('namespace', 'default')}, "
                f"link: {r['link']}"
            )

    lines.append("")
    lines.append("[응답 원칙]")
    lines.append("1. 먼저 [현재 화면] 과 [베이스 페이지 데이터] 를 읽고 화면 데이터로 답할 수 있으면 도구 호출 없이 답하세요.")
    lines.append("2. 화면 데이터는 스냅샷 시점 값입니다. 실시간 값이 중요하면 도구로 재조회하세요.")
    lines.append("3. 페이지네이션된 목록에서 visible_items 는 현재 페이지만 포함합니다.")
    lines.append("4. 지시대명사(\"이거\", \"여기\")는 가장 위 오버레이 > 베이스 페이지 순으로 해석하세요.")
    lines.append("5. `interpretations` 배열은 이미 검증된 결론입니다. 그대로 인용하세요.")
    lines.append("6. 리소스 언급 시 [RESOURCES IN CONTEXT] 의 link 필드로 마크다운 링크를 만드세요.")

    return "\n".join(lines)


def build_floating_system_prompt() -> str:
    """플로팅 어시스턴트의 시스템 프롬프트 전문(page_context 비의존 부분)."""
    return FLOATING_BASE_SYSTEM_PROMPT
