import { useEffect, useId, useMemo, useRef } from 'react'

import { usePageContext, type VisibleDataLayer } from '@/components/PageContext'
import { equalLayer } from '@/utils/aiContext/equalLayer'
import { throttle } from '@/utils/aiContext/throttle'
import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'

type LayerSource = string

export interface AIContextInput {
  source?: LayerSource
  summary: string
  data?: Record<string, unknown>
}

const THROTTLE_MS = 200

/**
 * 현재 컴포넌트가 보여주는 화면 데이터를 플로팅 AI 위젯의 컨텍스트에 등록한다.
 *
 * - input 이 null 이면 해당 레이어를 unregister (로딩 중이거나 스냅샷 불가 시)
 * - watch/polling 으로 매번 호출되어도 throttle(200ms) 로 상한 걸림
 * - throttle 이후에도 직전 등록값과 deep-equal 이면 재등록 skip
 * - 4KB 토큰 예산을 초과하는 data 는 자동 절삭
 *
 * @param input 레이어 스냅샷 (summary 필수, data 선택)
 * @param deps React dependency array — 원시값 deps 권장 (object deps 는 매 렌더 새 객체라 비효율)
 */
export function useAIContext(
  input: AIContextInput | null | undefined,
  deps: React.DependencyList,
): void {
  const { registerLayer, unregisterLayer } = usePageContext()
  const id = useId()
  const lastLayerRef = useRef<VisibleDataLayer | null>(null)

  const throttledRegister = useMemo(
    () => throttle<[string, VisibleDataLayer]>(registerLayer, THROTTLE_MS),
    [registerLayer],
  )

  useEffect(() => {
    if (!input) {
      lastLayerRef.current = null
      throttledRegister.cancel()
      unregisterLayer(id)
      return
    }

    const next: VisibleDataLayer = {
      source: input.source ?? 'base',
      summary: input.summary,
      data: input.data,
    }

    if (lastLayerRef.current && equalLayer(lastLayerRef.current, next)) {
      return
    }

    const budgeted = enforceTokenBudget(next)
    lastLayerRef.current = budgeted
    throttledRegister(id, budgeted)

    return () => {
      throttledRegister.cancel()
      unregisterLayer(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
