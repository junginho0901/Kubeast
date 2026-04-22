import type { VisibleDataLayer } from '@/components/PageContextProvider'

const MAX_BYTES = 4096 // D9: 레이어당 4KB
const MAX_SUMMARY_LEN = 300

/**
 * `useAIContext` 가 등록 직전에 호출. summary 가 너무 길면 자르고,
 * data JSON 직렬화 바이트 수가 4KB 를 초과하면 배열을 절반씩 줄여가며 맞춤.
 *
 * 목적: LLM 프롬프트 토큰 비용 상한 + 안전한 컨텍스트 크기.
 */
export function enforceTokenBudget(layer: VisibleDataLayer): VisibleDataLayer {
  let summary = layer.summary
  if (summary.length > MAX_SUMMARY_LEN) {
    summary = summary.slice(0, MAX_SUMMARY_LEN - 1) + '…'
  }

  let data = layer.data
  if (data) {
    const serialized = JSON.stringify(data)
    const bytes = new Blob([serialized]).size
    if (bytes > MAX_BYTES) {
      data = truncateData(data, MAX_BYTES)
      if (import.meta.env.DEV) {
        console.warn(
          `[useAIContext] layer "${layer.source}" 의 data 가 ${bytes}B → ${MAX_BYTES}B 로 절삭됨`,
        )
      }
    }
  }

  return { ...layer, summary, data }
}

function truncateData(
  data: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data }
  // 배열 필드를 반씩 줄여가며 크기 축소
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (Array.isArray(value)) {
      const arr = value
      result[key] = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)))
      const bytes = new Blob([JSON.stringify(result)]).size
      if (bytes <= maxBytes) return result
    }
  }
  // 그래도 초과면 요약본만 남김
  return { __truncated__: true, summary: (data.summary as unknown) ?? null }
}
