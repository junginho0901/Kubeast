"""Floating assistant prompt: the admin rule and the two admin screens it leaves readable."""
from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from app.prompts.floating_system_prompt import build_context_prompt, build_floating_system_prompt

# frontend/src/utils/aiContext/privateScreens.ts READABLE_ADMIN_PATHS
READABLE_ADMIN_PATHS = ["/admin/cluster-hygiene", "/admin/investigations"]


def test_admin_screens_keep_the_fixed_notice():
    prompt = build_floating_system_prompt()
    assert "경로가 `/admin` 으로 시작하는 화면" in prompt
    assert "AI 가 화면 내용을 읽을 수 없도록 설정되어 있습니다" in prompt


def test_cluster_hygiene_and_investigations_are_answered_like_other_screens():
    prompt = build_floating_system_prompt()
    for path in READABLE_ADMIN_PATHS:
        assert f"`{path}`" in prompt
    assert "다른 화면과 똑같이 답하세요" in prompt


def test_an_investigations_screen_puts_its_data_in_the_context():
    ctx = PageContextPayload(
        page_type="investigations",
        page_title="Investigations",
        path="/admin/investigations",
        snapshot_at="2026-10-17T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="알림 조사 보고서 1건", data={"items": [{"alertname": "KubePodCrashLooping"}]}),
        overlays=[VisibleDataLayer(source="InvestigationModal", summary="알림 조사 보고서 — KubePodCrashLooping", data={"report": "pod restarts"})],
    )
    text = build_context_prompt(ctx)
    assert "- 경로: /admin/investigations" in text
    assert "KubePodCrashLooping" in text
    assert "1. [InvestigationModal] 알림 조사 보고서 — KubePodCrashLooping ← 맨 위 (사용자가 지금 보고 있는 창)" in text


def test_only_the_last_window_is_marked_topmost():
    ctx = PageContextPayload(
        page_type="resource-list",
        page_title="ConfigMaps",
        path="/configuration/configmaps",
        snapshot_at="2026-10-17T00:00:00Z",
        overlays=[
            VisibleDataLayer(source="ResourceDetailDrawer", summary="ConfigMap kube-root-ca.crt 상세"),
            VisibleDataLayer(source="DeleteConfirm", summary="삭제 확인 창 — ConfigMap default/kube-root-ca.crt"),
        ],
    )
    text = build_context_prompt(ctx)
    assert text.count("← 맨 위") == 1
    assert "2. [DeleteConfirm] 삭제 확인 창 — ConfigMap default/kube-root-ca.crt ← 맨 위" in text
