import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import type { HelmReleaseSummary } from '@/services/api'

interface Params {
  items: HelmReleaseSummary[]
  paged: HelmReleaseSummary[]
  sortedCount: number
  currentPage: number
  rowsPerPage: number
  namespace: string
  searchQuery: string
}

export function useReleasesAISnapshot({
  items,
  paged,
  sortedCount,
  currentPage,
  rowsPerPage,
  namespace,
  searchQuery,
}: Params) {
  const aiSnapshot = useMemo(() => {
    if (items.length === 0) return null
    const total = items.length
    const failed = items.filter((r) => /fail|error/i.test(String(r.status))).length
    const pending = items.filter((r) => /pending/i.test(String(r.status))).length
    const deployed = items.filter((r) => /deployed/i.test(String(r.status))).length
    const prefix = failed > 0 ? '⚠️ ' : ''
    const nsLabel = namespace || '전체 네임스페이스'
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Helm Release ${total}개 (deployed ${deployed}, pending ${pending}, failed ${failed})`,
      data: {
        filters: { namespace: namespace || undefined, search: searchQuery || undefined },
        stats: { total, deployed, pending, failed },
        ...summarizeList(paged as unknown as Record<string, unknown>[], {
          total: sortedCount,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'revision', 'status', 'chart', 'chart_version', 'app_version', 'updated'],
          filterProblematic: (r) => /fail|error/i.test(String((r as unknown as HelmReleaseSummary).status)),
        }),
      },
    }
  }, [items, paged, sortedCount, currentPage, rowsPerPage, namespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])
}
