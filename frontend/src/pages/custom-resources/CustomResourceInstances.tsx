import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { JSONPath } from 'jsonpath-plus'
import { api, type CustomResourceInstanceInfo } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAdaptiveRowsPerPage } from '@/hooks/useAdaptiveRowsPerPage'
import { Loader2, ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'namespace' | 'kind' | 'group' | 'age' | string
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

interface PrinterColumn {
  name: string
  type: string
  jsonPath: string
  description?: string
}

function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getValueWithJSONPath(json: object, jsonPath: string): string {
  try {
    const result = JSONPath({ path: '$' + jsonPath, json, wrap: false })
    if (result === undefined || result === null) return ''
    return String(result)
  } catch {
    return ''
  }
}

export default function CustomResourceInstances() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const { data: instances, isLoading } = useQuery({
    queryKey: ['custom-resources', 'instances'],
    queryFn: () => api.getAllCustomResourceInstances(false),
  })

  // When kind is selected, find the corresponding CRD and fetch its describe for printer columns
  const selectedCRDName = useMemo(() => {
    if (!kindFilter || !Array.isArray(instances)) return ''
    const match = instances.find((inst) => inst.kind === kindFilter)
    return match?.crd_name || ''
  }, [kindFilter, instances])

  const { data: selectedCRDDescribe } = useQuery({
    queryKey: ['crd-describe', selectedCRDName],
    queryFn: () => api.describeCRD(selectedCRDName),
    enabled: !!selectedCRDName,
    retry: false,
  })

  // Extract printer columns from the selected CRD
  const printerColumns = useMemo<PrinterColumn[]>(() => {
    if (!selectedCRDDescribe?.versions) return []
    const versions = Array.isArray(selectedCRDDescribe.versions) ? selectedCRDDescribe.versions : []
    const storageVer = versions.find((v: any) => v.storage) || versions[0]
    if (!storageVer?.additionalPrinterColumns) return []
    return (storageVer.additionalPrinterColumns as any[]).filter(
      (col: any) => col.jsonPath !== '.metadata.creationTimestamp',
    )
  }, [selectedCRDDescribe?.versions])

  // When kind filter changes, also fetch full instances with rawJson for JSONPath
  const selectedGroup = useMemo(() => {
    if (!kindFilter || !Array.isArray(instances)) return ''
    const match = instances.find((inst) => inst.kind === kindFilter)
    return match?.group || ''
  }, [kindFilter, instances])

  const selectedVersion = useMemo(() => {
    if (!kindFilter || !Array.isArray(instances)) return ''
    const match = instances.find((inst) => inst.kind === kindFilter)
    return match?.version || ''
  }, [kindFilter, instances])

  const selectedPlural = useMemo(() => {
    if (!selectedCRDName) return ''
    return selectedCRDName.split('.')[0] || ''
  }, [selectedCRDName])

  // Fetch full CR instances with spec/status for JSONPath evaluation
  const { data: fullInstances } = useQuery({
    queryKey: ['custom-resources', 'full-instances', selectedGroup, selectedVersion, selectedPlural],
    queryFn: () => api.getCustomResourceInstances(selectedGroup, selectedVersion, selectedPlural),
    enabled: !!selectedGroup && !!selectedVersion && !!selectedPlural && printerColumns.length > 0,
    retry: false,
  })

  const uniqueKinds = useMemo(() => {
    if (!Array.isArray(instances)) return [] as string[]
    const kinds = new Set<string>()
    for (const inst of instances) {
      if (inst.kind) kinds.add(inst.kind)
    }
    return Array.from(kinds).sort()
  }, [instances])

  const filteredItems = useMemo(() => {
    if (!Array.isArray(instances)) return [] as CustomResourceInstanceInfo[]
    let result = instances

    if (kindFilter) {
      result = result.filter((inst) => inst.kind === kindFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (inst) =>
          inst.name.toLowerCase().includes(q) ||
          inst.namespace?.toLowerCase().includes(q) ||
          inst.kind.toLowerCase().includes(q) ||
          inst.group.toLowerCase().includes(q),
      )
    }

    return result
  }, [instances, searchQuery, kindFilter])

  const summary = useMemo(() => {
    const total = filteredItems.length
    const kinds = new Set<string>()
    const namespaces = new Set<string>()
    for (const inst of filteredItems) {
      if (inst.kind) kinds.add(inst.kind)
      if (inst.namespace) namespaces.add(inst.namespace)
    }
    return { total, kinds: kinds.size, namespaces: namespaces.size }
  }, [filteredItems])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('crInstancesPage.stats.total', 'Total Instances'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('crInstancesPage.stats.kinds', 'Unique Kinds'), summary.kinds, 'border-cyan-700/40 bg-cyan-900/10', 'text-cyan-300'],
      [tr('crInstancesPage.stats.namespaces', 'Namespaces'), summary.namespaces, 'border-purple-700/40 bg-purple-900/10', 'text-purple-300'],
    ],
    [summary.total, summary.kinds, summary.namespaces, tr],
  )

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedItems = useMemo(() => {
    if (!sortKey) return filteredItems
    const list = [...filteredItems]
    const getValue = (inst: CustomResourceInstanceInfo): string | number => {
      switch (sortKey) {
        case 'name': return inst.name
        case 'namespace': return inst.namespace || ''
        case 'kind': return inst.kind
        case 'group': return inst.group
        case 'age': return parseAgeSeconds(inst.created_at)
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
  }, [filteredItems, sortDir, sortKey])

  const rowsPerPage = useAdaptiveRowsPerPage(tableContainerRef, { recalculationKey: sortedItems.length })
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / rowsPerPage))

  useEffect(() => { setCurrentPage(1) }, [searchQuery, kindFilter])
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages) }, [currentPage, totalPages])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedItems.slice(start, start + rowsPerPage)
  }, [sortedItems, currentPage, rowsPerPage])

  // Build a lookup from name+namespace to full instance for JSONPath
  const fullInstanceMap = useMemo(() => {
    if (!Array.isArray(fullInstances)) return new Map<string, any>()
    const map = new Map<string, any>()
    for (const inst of fullInstances) {
      map.set(`${inst.namespace || '-'}/${inst.name}`, inst)
    }
    return map
  }, [fullInstances])

  const getColumnValue = (inst: CustomResourceInstanceInfo, col: PrinterColumn): string => {
    const key = `${inst.namespace || '-'}/${inst.name}`
    const full = fullInstanceMap.get(key)
    if (!full) return '-'
    // Build a minimal k8s-like object for JSONPath
    const json = {
      metadata: { name: full.name, namespace: full.namespace, creationTimestamp: full.created_at, labels: full.labels, annotations: full.annotations },
      spec: full.spec || {},
      status: full.status || {},
      ...full,
    }
    const value = getValueWithJSONPath(json, col.jsonPath)
    if (!value) return '-'
    if (col.type === 'date') {
      try {
        const d = new Date(value)
        if (!isNaN(d.getTime())) return formatAge(value)
      } catch { /* fall through */ }
    }
    return value
  }

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getAllCustomResourceInstances(true)
      queryClient.removeQueries({ queryKey: ['custom-resources', 'instances'] })
      queryClient.setQueryData(['custom-resources', 'instances'], data)
    } catch (error) {
      console.error('CR instances refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const showDynamicCols = kindFilter && printerColumns.length > 0
  const baseColCount = kindFilter ? 3 : 5 // name, ns, age when kind filtered; name, ns, kind, group, age otherwise
  const totalColCount = baseColCount + (showDynamicCols ? printerColumns.length : 0)

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('crInstancesPage.title', 'Custom Resource Instances')}</h1>
          <p className="mt-2 text-slate-400">{tr('crInstancesPage.subtitle', 'Browse all custom resource instances across CRDs.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleRefresh} disabled={isRefreshing} title={tr('crInstancesPage.refreshTitle', 'Force refresh')} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('crInstancesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="flex gap-3 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input type="text" placeholder={tr('crInstancesPage.searchPlaceholder', 'Search by name, namespace, kind, or group...')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent" />
        </div>
        <select
          value={kindFilter}
          onChange={(e) => { setKindFilter(e.target.value); setSortKey(null) }}
          className="h-12 min-w-[180px] px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        >
          <option value="">{tr('crInstancesPage.allKinds', 'All kinds')}</option>
          {uniqueKinds.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-3 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="text-lg text-white font-semibold mt-1">{value}</p>
          </div>
        ))}
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('crInstancesPage.matchCount', '{{count}} result(s) match.', { count: filteredItems.length })}
        </p>
      )}

      <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
        <div className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full text-sm min-w-[900px] table-fixed">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('crInstancesPage.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 w-[160px] cursor-pointer" onClick={() => handleSort('namespace')}>
                  <span className="inline-flex items-center gap-1">{tr('crInstancesPage.table.namespace', 'Namespace')}{renderSortIcon('namespace')}</span>
                </th>
                {!kindFilter && (
                  <>
                    <th className="text-left py-3 px-4 w-[150px] cursor-pointer" onClick={() => handleSort('kind')}>
                      <span className="inline-flex items-center gap-1">{tr('crInstancesPage.table.kind', 'Kind')}{renderSortIcon('kind')}</span>
                    </th>
                    <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('group')}>
                      <span className="inline-flex items-center gap-1">{tr('crInstancesPage.table.group', 'Group')}{renderSortIcon('group')}</span>
                    </th>
                  </>
                )}
                {showDynamicCols && printerColumns.map((col) => (
                  <th key={col.name} className="text-left py-3 px-4 w-[140px]" title={col.description || ''}>
                    <span className="inline-flex items-center gap-1 truncate">{col.name}</span>
                  </th>
                ))}
                <th className="text-left py-3 px-4 w-[100px] cursor-pointer" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('crInstancesPage.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pagedItems.map((inst) => (
                <tr
                  key={`${inst.group}/${inst.kind}/${inst.namespace || '-'}/${inst.name}`}
                  className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => openDetail({
                    kind: 'CustomResourceInstance',
                    name: inst.name,
                    namespace: inst.namespace || undefined,
                    rawJson: { group: inst.group, version: inst.version, crd_name: inst.crd_name, scope: inst.scope },
                  })}
                >
                  <td className="py-3 px-4 font-medium text-white"><span className="block truncate">{inst.name}</span></td>
                  <td className="py-3 px-4 text-xs"><span className="block truncate">{inst.namespace || '-'}</span></td>
                  {!kindFilter && (
                    <>
                      <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{inst.kind}</span></td>
                      <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{inst.group}</span></td>
                    </>
                  )}
                  {showDynamicCols && printerColumns.map((col) => (
                    <td key={col.name} className="py-3 px-4 text-xs font-mono">
                      <span className="block truncate">{getColumnValue(inst, col)}</span>
                    </td>
                  ))}
                  <td className="py-3 px-4 text-xs font-mono">{formatAge(inst.created_at)}</td>
                </tr>
              ))}
              {isLoading && (
                <tr>
                  <td colSpan={totalColCount} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}

              {sortedItems.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={totalColCount} className="py-6 px-4 text-center text-slate-400">
                    {tr('crInstancesPage.noResults', 'No custom resource instances found.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sortedItems.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
            <div className="text-xs text-slate-400">
              {tr('common.paginationRange', 'Showing {{start}}-{{end}} of {{total}}', {
                start: (currentPage - 1) * rowsPerPage + 1,
                end: Math.min(currentPage * rowsPerPage, sortedItems.length),
                total: sortedItems.length,
              })}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))} disabled={currentPage <= 1} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.prev', 'Prev')}
              </button>
              <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
              <button type="button" onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))} disabled={currentPage >= totalPages} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500">
                {tr('common.next', 'Next')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
