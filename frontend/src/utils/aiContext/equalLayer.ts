import type { VisibleDataLayer } from '@/components/PageContextProvider'

/**
 * 두 VisibleDataLayer 가 의미적으로 동일한지 비교.
 *
 * CopilotKit 의 `use-copilot-readable.ts` 패턴. throttle 이후에만 호출되므로
 * 직렬화 비용은 허용 범위. 배열 순서 / 중첩 객체 / Date 등 엣지 케이스 자동 처리.
 *
 * @returns a 와 b 가 같으면 true. 이 경우 `useAIContext` 는 재등록을 skip.
 */
export function equalLayer(a: VisibleDataLayer, b: VisibleDataLayer): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
