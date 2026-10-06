// Storage analysis modal — three tabs (PVCs / PVs / Topology) plus
// a namespace filter dropdown. Extracted from Dashboard.tsx; the
// parent prepares the filtered/sorted lists and topology query
// result and passes them in. The dropdown's outside-click detection
// is owned by this component (ref + useEffect) so the parent
// doesn't have to thread a ref through props.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, RefreshCw, Search, X } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'

interface Props {
  open: boolean
  onClose: () => void

  // Sorted lists prepared by parent
  sortedPVCs: any[]
  sortedPVs: any[]
  pvcStatusCounts: Record<string, number>
  pvStatusCounts: Record<string, number>

  // Tab + namespace filter
  activeTab: 'pvcs' | 'pvs' | 'topology'
  setActiveTab: (t: 'pvcs' | 'pvs' | 'topology') => void
  namespaceFilter: string
  setNamespaceFilter: (ns: string) => void
  namespaces: string[]
  isDropdownOpen: boolean
  setIsDropdownOpen: (b: boolean) => void

  // Search
  searchQuery: string
  setSearchQuery: (q: string) => void

  // Loading + topology
  isLoading: boolean
  storageTopology: any
  isLoadingStorageTopology: boolean
  isStorageTopologyError: boolean
  storageTopologyError: unknown
}

export function StorageModal({
  open,
  onClose,
  sortedPVCs,
  sortedPVs,
  pvcStatusCounts,
  pvStatusCounts,
  activeTab,
  setActiveTab,
  namespaceFilter,
  setNamespaceFilter,
  namespaces,
  isDropdownOpen,
  setIsDropdownOpen,
  searchQuery,
  setSearchQuery,
  isLoading,
  storageTopology,
  isLoadingStorageTopology,
  isStorageTopologyError,
  storageTopologyError,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const na = tr('common.notAvailable', 'N/A')

  // Outside-click → close namespace dropdown.
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDropdownOpen, setIsDropdownOpen])

  if (!open) return null

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg max-w-5xl w-full h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-white">
                {tr('dashboard.storage.title', 'Storage analysis')}
              </h2>
              <p className="text-sm text-slate-400">
                {tr('dashboard.storage.subtitle', 'Review PV/PVC status and binding state')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="badge badge-info">
              {tr('dashboard.storage.pvcCount', 'PVC {{count}}', { count: sortedPVCs.length })}
            </span>
            <span className="badge badge-info">
              {tr('dashboard.storage.pvCount', 'PV {{count}}', { count: sortedPVs.length })}
            </span>
            {Object.entries(pvcStatusCounts).slice(0, 4).map(([status, count]) => (
              <span
                key={`pvc-${status}`}
                className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Pending' ? 'badge-warning' : status === 'Lost' ? 'badge-error' : 'badge-info'}`}
                title={tr('dashboard.storage.pvcStatusTitle', 'PVC Status')}
              >
                {tr('dashboard.storage.pvcStatusCount', 'PVC {{status}} {{count}}', { status, count })}
              </span>
            ))}
            {Object.entries(pvStatusCounts).slice(0, 4).map(([status, count]) => (
              <span
                key={`pv-${status}`}
                className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Available' ? 'badge-info' : status === 'Released' ? 'badge-warning' : status === 'Failed' ? 'badge-error' : 'badge-info'}`}
                title={tr('dashboard.storage.pvStatusTitle', 'PV Status')}
              >
                {tr('dashboard.storage.pvStatusCount', 'PV {{status}} {{count}}', { status, count })}
              </span>
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveTab('pvcs')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'pvcs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
              >
                {tr('dashboard.storage.tabs.pvcs', 'PVC')}
              </button>
              <button
                onClick={() => setActiveTab('pvs')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'pvs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
              >
                {tr('dashboard.storage.tabs.pvs', 'PV')}
              </button>
              <button
                onClick={() => setActiveTab('topology')}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'topology' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
              >
                {tr('dashboard.storage.tabs.topology', 'Topology')}
              </button>
            </div>

            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
                title={tr('dashboard.storage.namespaceFilter', 'Namespace filter')}
              >
                <span className="text-sm font-medium">
                  {namespaceFilter === 'all'
                    ? tr('dashboard.storage.allNamespaces', 'All namespaces')
                    : namespaceFilter}
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-slate-400 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {isDropdownOpen && (
                <div className="absolute top-full right-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[340px] overflow-y-auto">
                  <button
                    onClick={() => {
                      setNamespaceFilter('all')
                      setIsDropdownOpen(false)
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
                  >
                    {namespaceFilter === 'all' && (
                      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                    )}
                    <span className={namespaceFilter === 'all' ? 'font-medium' : ''}>
                      {tr('dashboard.storage.allNamespaces', 'All namespaces')}
                    </span>
                  </button>
                  {namespaces.map((ns) => (
                    <button
                      key={ns}
                      onClick={() => {
                        setNamespaceFilter(ns)
                        setIsDropdownOpen(false)
                      }}
                      className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                    >
                      {namespaceFilter === ns && (
                        <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                      )}
                      <span className={namespaceFilter === ns ? 'font-medium' : ''}>{ns}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('dashboard.storage.searchPlaceholder', 'Search (name/status/StorageClass/Claim)...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded-sm transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
              <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
              <p className="text-slate-400">
                {tr('dashboard.storage.loading', 'Loading storage data...')}
              </p>
            </div>
          ) : activeTab === 'pvcs' ? (
            sortedPVCs.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-slate-400">{tr('dashboard.storage.noPVC', 'No PVCs to display')}</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                {sortedPVCs.map((pvc: any) => {
                  const status = String(pvc?.status ?? 'Unknown')
                  const badge =
                    status === 'Bound'
                      ? 'badge-success'
                      : status === 'Pending'
                        ? 'badge-warning'
                        : status === 'Lost'
                          ? 'badge-error'
                          : 'badge-info'

                  return (
                    <div key={`${pvc.namespace}/${pvc.name}`} className="p-3 bg-slate-900/20">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`badge ${badge}`}>{status}</span>
                            <p className="text-sm font-medium text-white truncate">{pvc.name}</p>
                          </div>
                          <div className="mt-1 space-y-0.5">
                            <p className="text-xs text-slate-400">
                              <span className="font-medium">{tr('dashboard.labels.namespaceShort', 'ns:')}</span> {pvc.namespace}
                            </p>
                            <p className="text-xs text-slate-400">
                              {pvc.capacity || na} · {pvc.storage_class || na} · {tr('dashboard.storage.pvLabel', 'PV')}: {pvc.volume_name || na}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : activeTab === 'pvs' ? (
            sortedPVs.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-slate-400">{tr('dashboard.storage.noPV', 'No PVs to display')}</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                {sortedPVs.map((pv: any) => {
                  const status = String(pv?.status ?? 'Unknown')
                  const badge =
                    status === 'Bound'
                      ? 'badge-success'
                      : status === 'Available'
                        ? 'badge-info'
                        : status === 'Released'
                          ? 'badge-warning'
                          : status === 'Failed'
                            ? 'badge-error'
                            : 'badge-info'

                  const claimNs = pv?.claim_ref?.namespace ? String(pv.claim_ref.namespace) : ''
                  const claimName = pv?.claim_ref?.name ? String(pv.claim_ref.name) : ''
                  const claim = claimNs && claimName ? `${claimNs}/${claimName}` : '—'

                  return (
                    <div key={pv.name} className="p-3 bg-slate-900/20">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`badge ${badge}`}>{status}</span>
                            <p className="text-sm font-medium text-white truncate">{pv.name}</p>
                          </div>
                          <div className="mt-1 space-y-0.5">
                            <p className="text-xs text-slate-400">
                              {pv.capacity || na} · {pv.storage_class || na} · {tr('dashboard.storage.reclaimLabel', 'Reclaim')}: {pv.reclaim_policy || na}
                            </p>
                            <p className="text-xs text-slate-400">
                              <span className="font-medium">{tr('dashboard.storage.claimLabel', 'Claim')}:</span> {claim}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : (
            <div className="space-y-4">
              {storageTopology ? (
                <div className="space-y-3">
                  <div className="p-4 rounded-lg border border-slate-700 bg-slate-900/20">
                    <p className="text-sm text-slate-200 font-medium">
                      {tr('dashboard.storage.topologyTitle', 'Storage Topology')}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      {tr('dashboard.storage.topologySummary', 'Nodes: {{nodes}} · Edges: {{edges}}', {
                        nodes: storageTopology.nodes?.length ?? 0,
                        edges: storageTopology.edges?.length ?? 0,
                      })}
                    </p>
                  </div>
                  {Array.isArray(storageTopology.edges) && storageTopology.edges.length > 0 ? (
                    <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                      {storageTopology.edges.slice(0, 50).map((edge: any) => (
                        <div key={edge.id} className="p-3 bg-slate-900/20">
                          <p className="text-xs text-slate-300">
                            {edge.source} → {edge.target}
                            {edge.label ? ` · ${edge.label}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {tr('dashboard.storage.noTopologyEdges', 'No topology edges to display')}
                      </p>
                    </div>
                  )}
                  {Array.isArray(storageTopology.edges) && storageTopology.edges.length > 50 && (
                    <p className="text-xs text-slate-500">
                      {tr('dashboard.storage.topologyLimit', 'Showing up to 50 edges')}
                    </p>
                  )}
                </div>
              ) : isLoadingStorageTopology ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                  <p className="text-slate-400">{tr('dashboard.storage.topologyLoading', 'Loading topology...')}</p>
                </div>
              ) : isStorageTopologyError ? (
                <div className="text-center py-12">
                  <p className="text-slate-400">{tr('dashboard.storage.topologyError', 'Failed to load topology')}</p>
                  <p className="text-xs text-slate-500 mt-2">
                    {(storageTopologyError as any)?.message || tr('dashboard.unknownError', 'Unknown error')}
                  </p>
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-slate-400">
                    {tr('dashboard.storage.topologyUnavailable', 'Topology data is unavailable')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
