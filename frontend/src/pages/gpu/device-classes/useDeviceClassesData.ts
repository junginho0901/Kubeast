import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type DeviceClassItem } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  applyDeviceClassWatchEvent,
  formatConditions,
  parseAgeSeconds,
  type SortKey,
} from './deviceClassesHelpers'

interface UseParams {
  searchQuery: string
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  currentPage: number
}

export function useDeviceClassesData({ searchQuery, sortKey, sortDir, currentPage }: UseParams) {
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)

  const { data: deviceClasses, isLoading } = useQuery({
    queryKey: ['gpu', 'deviceclasses'],
    queryFn: () => api.getDeviceClasses(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.deviceclass.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['gpu', 'deviceclasses'],
    path: '/api/v1/deviceclasses',
    query: 'watch=1',
    applyEvent: (prev, event) => applyDeviceClassWatchEvent(prev as DeviceClassItem[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['deviceclass-describe', name] })
      }
    },
  })

  const filteredDeviceClasses = useMemo(() => {
    if (!Array.isArray(deviceClasses)) return [] as DeviceClassItem[]
    if (!searchQuery.trim()) return deviceClasses
    const q = searchQuery.toLowerCase()
    return deviceClasses.filter((item) => (
      item.name.toLowerCase().includes(q)
    ))
  }, [deviceClasses, searchQuery])

  const summary = useMemo(() => {
    const total = filteredDeviceClasses.length
    let withConditions = 0

    for (const item of filteredDeviceClasses) {
      if (Array.isArray(item.conditions) && item.conditions.length > 0) withConditions += 1
    }

    return { total, withConditions }
  }, [filteredDeviceClasses])

  const sortedDeviceClasses = useMemo(() => {
    if (!sortKey) return filteredDeviceClasses
    const list = [...filteredDeviceClasses]

    const getValue = (item: DeviceClassItem): string | number => {
      switch (sortKey) {
        case 'name':
          return item.name
        case 'selectors':
          return item.selector_count ?? 0
        case 'conditions':
          return formatConditions(item.conditions)
        case 'age':
          return parseAgeSeconds(item.created_at)
        default:
          return ''
      }
    }

    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })

    return list
  }, [filteredDeviceClasses, sortDir, sortKey])

  const adaptive = useAdaptiveTable({
    recalculationKey: sortedDeviceClasses.length,
  })
  const { rowsPerPage } = adaptive
  const totalPages = Math.max(1, Math.ceil(sortedDeviceClasses.length / Math.max(rowsPerPage, 1)))

  const pagedDeviceClasses = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedDeviceClasses.slice(start, start + rowsPerPage)
  }, [sortedDeviceClasses, currentPage, rowsPerPage])

  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(deviceClasses) || deviceClasses.length === 0) return null
    const total = deviceClasses.length
    return {
      source: 'base' as const,
      summary: `DeviceClass ${total}개 (DRA)`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total },
        ...summarizeList(pagedDeviceClasses as unknown as Record<string, unknown>[], {
          total: sortedDeviceClasses.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name'],
          linkBuilder: (d) => {
            const dc = d as unknown as DeviceClassItem
            return buildResourceLink('DeviceClass', undefined, dc.name)
          },
        }),
      },
    }
  }, [deviceClasses, pagedDeviceClasses, sortedDeviceClasses.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getDeviceClasses(true)
      queryClient.removeQueries({ queryKey: ['gpu', 'deviceclasses'] })
      queryClient.setQueryData(['gpu', 'deviceclasses'], data)
    } catch (error) {
      console.error('DeviceClasses refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return {
    queryClient,
    isLoading,
    isRefreshing,
    handleRefresh,
    canCreate,
    filteredDeviceClasses,
    sortedDeviceClasses,
    pagedDeviceClasses,
    summary,
    rowsPerPage,
    totalPages,
    tableContainerRef: adaptive.containerRef,
    tableBodyRef: adaptive.bodyRef,
    theadRef: adaptive.theadRef,
    firstRowRef: adaptive.firstRowRef,
  }
}
