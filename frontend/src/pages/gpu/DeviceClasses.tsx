import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { useDeviceClassesData } from './device-classes/useDeviceClassesData'
import type { SortKey } from './device-classes/deviceClassesHelpers'
import DeviceClassesTable from './device-classes/DeviceClassesTable'

export default function DeviceClasses() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const {
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
    tableContainerRef,
    tableBodyRef,
    theadRef,
    firstRowRef,
  } = useDeviceClassesData({ searchQuery, sortKey, sortDir, currentPage })

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const createDeviceClassYamlTemplate = useMemo(() => {
    return `apiVersion: resource.k8s.io/v1beta1
kind: DeviceClass
metadata:
  name: example-gpu-class
spec:
  selectors:
    - cel:
        expression: "device.driver == 'gpu.nvidia.com'"
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('deviceClassesPage.title', 'Device Classes')}</h1>
          <p className="mt-2 text-slate-400">{tr('deviceClassesPage.subtitle', 'Manage DRA DeviceClass resources for dynamic resource allocation.')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('deviceClassesPage.create', 'Create DeviceClass')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={tr('deviceClassesPage.refreshTitle', 'Force refresh')}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('deviceClassesPage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          placeholder={tr('deviceClassesPage.searchPlaceholder', 'Search device classes by name...')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 shrink-0">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-slate-400">{tr('deviceClassesPage.stats.total', 'Total')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.total}</p>
        </div>
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-3">
          <p className="text-[11px] sm:text-xs leading-4 whitespace-nowrap text-amber-300">{tr('deviceClassesPage.stats.withConditions', 'With Conditions')}</p>
          <p className="text-lg text-white font-semibold mt-1">{summary.withConditions}</p>
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400 shrink-0">
          {tr('deviceClassesPage.matchCount', '{{count}} device class{{suffix}} match.', {
            count: filteredDeviceClasses.length,
            suffix: filteredDeviceClasses.length === 1 ? '' : 'es',
          })}
        </p>
      )}

      <DeviceClassesTable
        sortedDeviceClasses={sortedDeviceClasses}
        pagedDeviceClasses={pagedDeviceClasses}
        isLoading={isLoading}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        currentPage={currentPage}
        totalPages={totalPages}
        rowsPerPage={rowsPerPage}
        setCurrentPage={setCurrentPage}
        tableContainerRef={tableContainerRef}
        tableBodyRef={tableBodyRef}
        theadRef={theadRef}
        firstRowRef={firstRowRef}
      />

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('deviceClassesPage.createTitle', 'Create DeviceClass from YAML')}
          initialYaml={createDeviceClassYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['gpu', 'deviceclasses'] })
          }}
        />
      )}
    </div>
  )
}
