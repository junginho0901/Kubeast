import { useMemo } from 'react'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import type { NamespaceInfo } from './namespaceHelpers'

interface Params {
  namespaces: NamespaceInfo[] | undefined
  pagedNamespaces: NamespaceInfo[]
  sortedNamespacesCount: number
  currentPage: number
  rowsPerPage: number
  searchQuery: string
}

export function useNamespacesAISnapshot({
  namespaces,
  pagedNamespaces,
  sortedNamespacesCount,
  currentPage,
  rowsPerPage,
  searchQuery,
}: Params) {
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(namespaces) || namespaces.length === 0) return null
    const total = namespaces.length
    const inactive = namespaces.filter((n) => !/active/i.test(n.status)).length
    const prefix = inactive > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}Namespace ${total}개${inactive ? ` (Inactive ${inactive})` : ''}`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, inactive },
        ...summarizeList(pagedNamespaces as unknown as Record<string, unknown>[], {
          total: sortedNamespacesCount,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'status', 'age'],
          filterProblematic: (n) => !/active/i.test((n as unknown as NamespaceInfo).status),
          linkBuilder: (n) => {
            const ns = n as unknown as NamespaceInfo
            return buildResourceLink('Namespace', undefined, ns.name)
          },
        }),
      },
    }
  }, [namespaces, pagedNamespaces, sortedNamespacesCount, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])
}
