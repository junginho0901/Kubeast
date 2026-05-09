// Watch event 의 부분 데이터로 list 의 정상 항목을 통째로 덮어쓰지 않도록
// merge 하는 helper.
//
// 배경: backend 의 *ToInfo 함수 (multiplexer_info.go) 가 list endpoint 의
// formatXDetail 과 다른 (대부분 더 적은) 필드를 반환. 예: deployment list 는
// status/image/ready_replicas/available_replicas/updated_replicas 등을 주는데
// deploymentToInfo 는 name/namespace/replicas/ready/labels/created_at 만.
// 이 부분 데이터로 list 항목을 통째로 replace 하면 화면에서 status="Unknown"
// 등으로 데이터가 사라진 것처럼 보이는 회귀 발생 (전체 45개 list 페이지 영향).
//
// 정책: update 의 의미 있는 값만 prev 위에 덮어쓰고, null/undefined/'Unknown'/
// empty string/empty array 같은 fallback 값은 무시 — list 의 정상 값을 유지.
export function mergeWatchUpdate<T>(prev: T, update: T): T {
  if (!prev) return update
  const result: Record<string, unknown> = { ...(prev as Record<string, unknown>) }
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (value === 'Unknown' || value === '') continue
    if (Array.isArray(value) && value.length === 0) {
      // prev 도 array 면 prev 유지 (watch 가 partial 로 빈 array 보내는 케이스
      // 보호). prev 가 비어있으면 update 의 빈 array 그대로.
      const prevValue = (prev as Record<string, unknown>)[key]
      if (Array.isArray(prevValue) && prevValue.length > 0) continue
    }
    result[key] = value
  }
  return result as T
}
