import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { failureFields, readFailure } from '@/utils/aiContext/readFailure'
import type { HelmReleaseSummary } from '@/services/api'

interface Params {
  loaded: boolean
  // the list the page says it could not read (refused, or failed with no rows): told with its reason, never a count
  error?: unknown
  // the summary cards' counts
  stats: { total: number; deployed: number; failed: number; pending: number; superseded: number }
  paged: HelmReleaseSummary[]
  sortedCount: number
  currentPage: number
  rowsPerPage: number
  namespace: string
  searchQuery: string
}

export function useReleasesAISnapshot({
  loaded,
  error,
  stats,
  paged,
  sortedCount,
  currentPage,
  rowsPerPage,
  namespace,
  searchQuery,
}: Params) {
  const aiSnapshot = useMemo(() => {
    const nsLabel = namespace || '전체 네임스페이스'
    const filters = { namespace: namespace || undefined, search: searchQuery || undefined }
    if (error) {
      const f = readFailure(error)
      return {
        source: 'base' as const,
        summary: `${nsLabel} Helm Release — ${f.refused ? '볼 권한 없음' : '불러오지 못함'}: ${f.reason}`,
        data: { filters, ...failureFields('', error) },
      }
    }
    if (!loaded) return null
    const prefix = stats.failed > 0 ? '⚠️ ' : ''
    // the table's columns, under the names the release window's layer gives them
    const rows = paged.map((r) => ({
      name: r.name, namespace: r.namespace, revision: r.revision, status: r.status, chart: r.chart,
      chart_version: r.chartVersion, app_version: r.appVersion, updated: r.updated,
    }))
    return {
      source: 'base' as const,
      summary: `${prefix}${nsLabel} Helm Release ${stats.total}개 (deployed ${stats.deployed}, pending ${stats.pending}, failed ${stats.failed}, superseded ${stats.superseded})`,
      data: {
        filters,
        stats,
        ...summarizeList(rows, {
          total: sortedCount,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          filterProblematic: (r) => /fail|error/i.test(String(r.status)),
        }),
      },
    }
  }, [loaded, error, stats, paged, sortedCount, currentPage, rowsPerPage, namespace, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])
}
