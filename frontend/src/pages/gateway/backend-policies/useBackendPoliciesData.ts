import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  applyWatchEvent,
  formatTargetRefs,
  parseAgeSeconds,
  type BackendPolicyLike,
  type SortKey,
} from './helpers'

export interface BackendPolicyConfig<T extends BackendPolicyLike> {
  kind: string
  /** Tuple prefix preserved verbatim for cache invalidation cross-module (e.g. ['gateway', 'backendtlspolicies']) */
  queryKeyPrefix: readonly [string, string]
  watchPath: (namespace: string) => string
  describeQueryKey: string
  permissionCreate: string
  list: (namespace: string, force: boolean) => Promise<T[]>
  listAll: (force: boolean) => Promise<T[]>
  aiSummaryLabel: string
}

interface UseParams<T extends BackendPolicyLike> {
  config: BackendPolicyConfig<T>
  searchQuery: string
  selectedNamespace: string
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  currentPage: number
}

export function useBackendPoliciesData<T extends BackendPolicyLike>({
  config,
  searchQuery,
  selectedNamespace,
  sortKey,
  sortDir,
  currentPage,
}: UseParams<T>) {
  const queryClient = useQueryClient()
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const queryKey = [...config.queryKeyPrefix, selectedNamespace]

  const { data: policies, isLoading } = useQuery({
    queryKey,
    queryFn: () => (
      selectedNamespace === 'all'
        ? config.listAll(false)
        : config.list(selectedNamespace, false)
    ),
  })
  const { has } = usePermission()
  const canCreate = has(config.permissionCreate)

  useKubeWatchList({
    enabled: true,
    queryKey,
    path: config.watchPath(selectedNamespace),
    query: 'watch=1',
    applyEvent: (prev, event) => applyWatchEvent<T>(prev as T[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      const ns = event?.object?.namespace || event?.object?.metadata?.namespace
      if (name && ns) {
        queryClient.invalidateQueries({ queryKey: [config.describeQueryKey, ns, name] })
      }
    },
  })

  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNamespaceDropdownOpen])

  const filteredPolicies = useMemo(() => {
    if (!Array.isArray(policies)) return [] as T[]
    if (!searchQuery.trim()) return policies as T[]
    const q = searchQuery.toLowerCase()
    return (policies as T[]).filter((item) => (
      item.name.toLowerCase().includes(q)
      || item.namespace.toLowerCase().includes(q)
      || formatTargetRefs(item).toLowerCase().includes(q)
    ))
  }, [policies, searchQuery])

  const summary = useMemo(() => {
    const total = filteredPolicies.length
    let accepted = 0
    let withTargetRefs = 0
    for (const item of filteredPolicies) {
      if ((item.target_refs || []).length > 0) withTargetRefs += 1
      const conds = Array.isArray(item.conditions) ? item.conditions : []
      const acc = conds.find((c) => c.type === 'Accepted')
      if (acc && acc.status === 'True') accepted += 1
    }
    return { total, accepted, withTargetRefs }
  }, [filteredPolicies])

  const sortedPolicies = useMemo(() => {
    if (!sortKey) return filteredPolicies
    const list = [...filteredPolicies]
    const getValue = (item: T): string | number => {
      switch (sortKey) {
        case 'name': return item.name
        case 'namespace': return item.namespace
        case 'targetRef': return formatTargetRefs(item)
        case 'age': return parseAgeSeconds(item.created_at)
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [filteredPolicies, sortDir, sortKey])

  const adaptive = useAdaptiveTable({ recalculationKey: sortedPolicies.length })
  const { rowsPerPage } = adaptive
  const totalPages = Math.max(1, Math.ceil(sortedPolicies.length / Math.max(rowsPerPage, 1)))

  const pagedPolicies = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedPolicies.slice(start, start + rowsPerPage)
  }, [sortedPolicies, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(policies) || policies.length === 0) return null
    const nsLabel = selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace
    const total = policies.length
    return {
      source: 'base' as const,
      summary: `${nsLabel} ${config.aiSummaryLabel} ${total}개`,
      data: {
        filters: { namespace: selectedNamespace, search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedPolicies as unknown as Record<string, unknown>[], {
          total: sortedPolicies.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'target_refs'],
          linkBuilder: (p) => {
            const pol = p as unknown as BackendPolicyLike
            return buildResourceLink(config.kind, pol.namespace, pol.name)
          },
        }),
      },
    }
  }, [policies, pagedPolicies, sortedPolicies.length, currentPage, rowsPerPage, selectedNamespace, searchQuery, config.aiSummaryLabel, config.kind])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = selectedNamespace === 'all'
        ? await config.listAll(true)
        : await config.list(selectedNamespace, true)
      queryClient.removeQueries({ queryKey })
      queryClient.setQueryData(queryKey, data)
    } catch (error) {
      console.error(`${config.kind} refresh failed:`, error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return {
    namespaces,
    namespaceDropdownRef,
    isNamespaceDropdownOpen,
    setIsNamespaceDropdownOpen,
    canCreate,
    isLoading,
    isRefreshing,
    handleRefresh,
    filteredPolicies,
    sortedPolicies,
    pagedPolicies,
    summary,
    rowsPerPage,
    totalPages,
    tableContainerRef: adaptive.containerRef,
    tableBodyRef: adaptive.bodyRef,
    theadRef: adaptive.theadRef,
    firstRowRef: adaptive.firstRowRef,
    queryClient,
    queryKey,
  }
}
