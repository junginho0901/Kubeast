import type { PageContextSnapshot } from '@/components/PageContext'

/**
 * 프론트 camelCase 스냅샷을 백엔드 Pydantic snake_case 스키마로 직렬화.
 *
 * `services/ai-service/app/models/floating_ai.py` 의 `PageContextPayload`
 * 와 키 이름이 1:1 일치해야 한다 (불일치 시 422 Unprocessable Entity).
 *
 * `base` / `overlays` 의 `VisibleDataLayer` 는 양쪽 모두 같은 키
 * (source, summary, data) 라 그대로 통과.
 */
export function serializeSnapshotForBackend(
  s: PageContextSnapshot,
): Record<string, unknown> {
  return {
    page_type: s.pageType,
    page_title: s.pageTitle,
    path: s.path,
    resource_kind: s.resourceKind,
    namespace: s.namespace,
    cluster: s.cluster,
    context_changed: s.contextChanged,
    snapshot_at: s.snapshotAt,
    base: s.base,
    overlays: s.overlays,
  }
}
