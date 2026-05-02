import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type VolumeAttachmentInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Loader2, ChevronDown, ChevronUp, Plus, RefreshCw, Search } from 'lucide-react'

type SortKey = null | 'name' | 'attacher' | 'pv' | 'node' | 'attached' | 'error' | 'age'
type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

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

function normalizeError(error?: { time?: string | null; message?: string | null } | null): { time?: string | null; message?: string | null } | null {
  if (!error) return null
  const message = typeof error.message === 'string' ? error.message : null
  const time = typeof error.time === 'string' ? error.time : null
  if (!message && !time) return null
  return { message, time }
}

function normalizeWatchVolumeAttachmentObject(obj: any): VolumeAttachmentInfo {
  if (typeof obj?.name === 'string') {
    return {
      name: obj.name,
      attacher: obj?.attacher ?? null,
      node_name: obj?.node_name ?? null,
      persistent_volume_name: obj?.persistent_volume_name ?? null,
      attached: typeof obj?.attached === 'boolean' ? obj.attached : null,
      attach_error: normalizeError(obj?.attach_error),
      detach_error: normalizeError(obj?.detach_error),
      created_at: obj?.created_at ?? null,
    }
  }

  const metadata = obj?.metadata ?? {}
  const spec = obj?.spec ?? {}
  const source = spec?.source ?? {}
  const status = obj?.status ?? {}
  const attachError = status?.attachError ?? status?.attach_error
  const detachError = status?.detachError ?? status?.detach_error

  return {
    name: metadata?.name ?? '',
    attacher: spec?.attacher ?? null,
    node_name: spec?.nodeName ?? spec?.node_name ?? null,
    persistent_volume_name:
      source?.persistentVolumeName
      ?? source?.persistent_volume_name
      ?? null,
    attached: typeof status?.attached === 'boolean' ? status.attached : null,
    attach_error: normalizeError(attachError),
    detach_error: normalizeError(detachError),
    created_at: metadata?.creationTimestamp ?? null,
  }
}

function applyVolumeAttachmentWatchEvent(
  prev: VolumeAttachmentInfo[] | undefined,
  event: { type?: string; object?: any },
): VolumeAttachmentInfo[] {
  const items = Array.isArray(prev) ? [...prev] : []
  const obj = event?.object
  if (!obj) return items

  const normalized = normalizeWatchVolumeAttachmentObject(obj)
  const name = normalized?.name
  if (!name) return items

  const index = items.findIndex((item) => item.name === name)

  if (event.type === 'DELETED') {
    if (index >= 0) items.splice(index, 1)
    return items
  }

  if (index >= 0) items[index] = normalized
  else items.push(normalized)
  return items
}

function statusLabel(va: VolumeAttachmentInfo): 'Attached' | 'Detached' | 'Error' | 'Unknown' {
  if (va.attach_error?.message || va.detach_error?.message) return 'Error'
  if (va.attached === true) return 'Attached'
  if (va.attached === false) return 'Detached'
  return 'Unknown'
}

function statusBadgeClass(status: string): string {
  const lower = status.toLowerCase()
  if (lower === 'attached') return 'badge-success'
  if (lower === 'detached') return 'badge-warning'
  if (lower === 'error') return 'badge-error'
  return 'badge-info'
}

function toRawJson(va: VolumeAttachmentInfo): Record<string, unknown> {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'VolumeAttachment',
    metadata: {
      name: va.name,
      creationTimestamp: va.created_at,
    },
    spec: {
      attacher: va.attacher,
      nodeName: va.node_name,
      source: {
        persistentVolumeName: va.persistent_volume_name,
      },
    },
    status: {
      attached: va.attached,
      attachError: va.attach_error
        ? {
            message: va.attach_error.message,
            time: va.attach_error.time,
          }
        : undefined,
      detachError: va.detach_error
        ? {
            message: va.detach_error.message,
            time: va.detach_error.time,
          }
        : undefined,
    },
  }
}

function errorText(va: VolumeAttachmentInfo): string {
  const attachMessage = va.attach_error?.message || ''
  const detachMessage = va.detach_error?.message || ''
  if (attachMessage && detachMessage) return `${attachMessage} | ${detachMessage}`
  return attachMessage || detachMessage || '-'
}

export default function VolumeAttachments() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const {
    data: volumeAttachments,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['storage', 'volumeattachments'],
    queryFn: () => api.getVolumeAttachments(false),
  })
  const { has } = usePermission()
  const canCreate = has('resource.volumeattachment.create')

  useKubeWatchList({
    enabled: true,
    queryKey: ['storage', 'volumeattachments'],
    path: '/api/v1/volumeattachments',
    query: 'watch=1',
    applyEvent: (prev, event) => applyVolumeAttachmentWatchEvent(prev as VolumeAttachmentInfo[] | undefined, event),
    onEvent: (event) => {
      if (event?.type === 'DELETED') return
      const name = event?.object?.name || event?.object?.metadata?.name
      if (name) {
        queryClient.invalidateQueries({ queryKey: ['volumeattachment-describe', name] })
      }
    },
  })

  const filteredVolumeAttachments = useMemo(() => {
    if (!Array.isArray(volumeAttachments)) return [] as VolumeAttachmentInfo[]
    if (!searchQuery.trim()) return volumeAttachments
    const q = searchQuery.toLowerCase()

    return volumeAttachments.filter((va) => {
      return va.name.toLowerCase().includes(q)
        || String(va.attacher || '').toLowerCase().includes(q)
        || String(va.persistent_volume_name || '').toLowerCase().includes(q)
        || String(va.node_name || '').toLowerCase().includes(q)
        || String(va.attached).toLowerCase().includes(q)
        || statusLabel(va).toLowerCase().includes(q)
        || String(va.attach_error?.message || '').toLowerCase().includes(q)
        || String(va.detach_error?.message || '').toLowerCase().includes(q)
    })
  }, [volumeAttachments, searchQuery])

  const summary = useMemo(() => {
    const total = filteredVolumeAttachments.length
    let attached = 0
    let detached = 0
    let errors = 0

    for (const va of filteredVolumeAttachments) {
      if (va.attach_error?.message || va.detach_error?.message) errors += 1
      if (va.attached === true) attached += 1
      if (va.attached === false) detached += 1
    }

    return { total, attached, detached, errors }
  }, [filteredVolumeAttachments])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [tr('volumeattachments.stats.total', 'Total'), summary.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [tr('volumeattachments.stats.attached', 'Attached'), summary.attached, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [tr('volumeattachments.stats.detached', 'Detached'), summary.detached, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [tr('volumeattachments.stats.errors', 'Errors'), summary.errors, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
    ],
    [summary.attached, summary.detached, summary.errors, summary.total, tr],
  )

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

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sortedVolumeAttachments = useMemo(() => {
    if (!sortKey) return filteredVolumeAttachments
    const list = [...filteredVolumeAttachments]

    const getValue = (va: VolumeAttachmentInfo): string | number => {
      switch (sortKey) {
        case 'name':
          return va.name
        case 'attacher':
          return va.attacher || ''
        case 'pv':
          return va.persistent_volume_name || ''
        case 'node':
          return va.node_name || ''
        case 'attached':
          return va.attached === true ? 1 : va.attached === false ? 0 : -1
        case 'error':
          return (va.attach_error?.message || va.detach_error?.message) ? 1 : 0
        case 'age':
          return parseAgeSeconds(va.created_at)
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
  }, [filteredVolumeAttachments, sortDir, sortKey])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sortedVolumeAttachments.length,
  })
  const totalPages = Math.max(1, Math.ceil(sortedVolumeAttachments.length / rowsPerPage))

  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pagedVolumeAttachments = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sortedVolumeAttachments.slice(start, start + rowsPerPage)
  }, [sortedVolumeAttachments, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷 (cluster-scoped)
  const aiSnapshot = useMemo(() => {
    if (!Array.isArray(volumeAttachments) || volumeAttachments.length === 0) return null
    const total = volumeAttachments.length
    const withError = volumeAttachments.filter((v) => !!(v.attach_error || v.detach_error)).length
    const prefix = withError > 0 ? '⚠️ ' : ''
    return {
      source: 'base' as const,
      summary: `${prefix}VolumeAttachment ${total}개${withError ? `, 오류 ${withError}` : ''}`,
      data: {
        filters: { search: searchQuery || undefined },
        stats: { total, with_error: withError },
        ...summarizeList(pagedVolumeAttachments as unknown as Record<string, unknown>[], {
          total: sortedVolumeAttachments.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'attacher', 'persistent_volume_name', 'node_name', 'attached', 'attach_error', 'detach_error'],
          filterProblematic: (v) => {
            const va = v as unknown as VolumeAttachmentInfo
            return !!(va.attach_error || va.detach_error)
          },
          linkBuilder: (v) => {
            const va = v as unknown as VolumeAttachmentInfo
            return buildResourceLink('VolumeAttachment', undefined, va.name)
          },
        }),
      },
    }
  }, [volumeAttachments, pagedVolumeAttachments, sortedVolumeAttachments.length, currentPage, rowsPerPage, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      const data = await api.getVolumeAttachments(true)
      queryClient.removeQueries({ queryKey: ['storage', 'volumeattachments'] })
      queryClient.setQueryData(['storage', 'volumeattachments'], data)
    } catch (error) {
      console.error('VolumeAttachment refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const createVolumeAttachmentYamlTemplate = useMemo(() => {
    return `apiVersion: storage.k8s.io/v1
kind: VolumeAttachment
metadata:
  name: sample-volumeattachment
spec:
  attacher: csi.example.com
  nodeName: worker-node-1
  source:
    persistentVolumeName: sample-pv
`
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-3xl font-bold text-white shrink-0">{tr('volumeattachments.title', 'Volume Attachments')}</h1>
            <span
              className="hidden xl:inline text-[10px] leading-4 text-cyan-300"
              title={tr(
                'storage.volumeAttachment.infoTitle',
                'VolumeAttachments are created for CSI volumes that require attach/detach. (e.g., NFS may not create them)',
              )}
            >
              <span className="block">
                {tr(
                  'storage.volumeAttachment.infoLine1',
                  'VolumeAttachments are created for CSI volumes that require attach/detach.',
                )}
              </span>
              <span className="block">
                {tr(
                  'storage.volumeAttachment.infoLine2',
                  '(e.g., NFS may not create them)',
                )}
              </span>
            </span>
          </div>
          <p className="mt-2 text-slate-400">
            {tr('volumeattachments.subtitle', 'Inspect cluster-wide volume attachment state and troubleshooting signals.')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="btn btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              {tr('volumeattachments.create', 'Create VolumeAttachment')}
            </button>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={tr('volumeattachments.refreshTitle', 'Force refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {tr('volumeattachments.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('volumeattachments.searchPlaceholder', 'Search VolumeAttachments by name, PV, node, or attacher...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelClass]) => (
          <div key={label} className={`rounded-lg border px-4 py-3 ${boxClass}`}>
            <p className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelClass}`}>{label}</p>
            <p className="mt-1 text-lg font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="card flex-1 min-h-0 flex flex-col" ref={tableContainerRef}>
        {isError && (
          <div className="px-4 py-3 border-b border-slate-800">
            <p className="text-xs text-amber-300">
              {tr(
                'storage.volumeAttachment.loadError',
                'Failed to load VolumeAttachments. (This may be restricted by cluster permissions or environment)',
              )}
            </p>
          </div>
        )}

        <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead ref={theadRef} className="text-slate-400">
              <tr>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('name')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.name', 'Name')}{renderSortIcon('name')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('attacher')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.attacher', 'Attacher')}{renderSortIcon('attacher')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('pv')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.persistentVolume', 'Persistent Volume')}{renderSortIcon('pv')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('node')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.node', 'Node')}{renderSortIcon('node')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('attached')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.attached', 'Attached')}{renderSortIcon('attached')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('error')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.error', 'Error')}{renderSortIcon('error')}</span>
                </th>
                <th className="text-left py-3 px-4 cursor-pointer select-none" onClick={() => handleSort('age')}>
                  <span className="inline-flex items-center gap-1">{tr('volumeattachments.table.age', 'Age')}{renderSortIcon('age')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {pagedVolumeAttachments.map((va, idx) => {
                const status = statusLabel(va)
                const errors = errorText(va)
                return (
                  <tr
                    key={va.name}
                    ref={idx === 0 ? firstRowRef : undefined}
                    className="hover:bg-slate-800/30 cursor-pointer"
                    onClick={() => openDetail({ kind: 'VolumeAttachment', name: va.name, rawJson: toRawJson(va) })}
                  >
                    <td className="py-3 px-4 text-white font-mono break-all">{va.name}</td>
                    <td className="py-3 px-4 text-slate-300 break-all">{va.attacher || '-'}</td>
                    <td className="py-3 px-4 text-slate-300">
                      {va.persistent_volume_name ? (
                        <button
                          type="button"
                          className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                          onClick={(e) => {
                            e.stopPropagation()
                            openDetail({ kind: 'PersistentVolume', name: va.persistent_volume_name as string })
                          }}
                        >
                          {va.persistent_volume_name}
                        </button>
                      ) : '-'}
                    </td>
                    <td className="py-3 px-4 text-slate-300">
                      {va.node_name ? (
                        <button
                          type="button"
                          className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                          onClick={(e) => {
                            e.stopPropagation()
                            openDetail({ kind: 'Node', name: va.node_name as string })
                          }}
                        >
                          {va.node_name}
                        </button>
                      ) : '-'}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`badge ${statusBadgeClass(status)}`}>{status}</span>
                    </td>
                    <td className="py-3 px-4 text-slate-300 max-w-[320px]">
                      <span className="block truncate" title={errors}>{errors}</span>
                    </td>
                    <td className="py-3 px-4 text-slate-400">{formatAge(va.created_at)}</td>
                  </tr>
                )
              })}

              {!isLoading && pagedVolumeAttachments.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    {tr('volumeattachments.noResults', 'No VolumeAttachments found.')}
                  </td>
                </tr>
              )}

              {isLoading && (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-slate-400">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            <AdaptiveTableFillerRows count={rowsPerPage - pagedVolumeAttachments.length} columnCount={7} />
          </table>
        </div>

        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between shrink-0">
          <p className="text-xs text-slate-400">
            {sortedVolumeAttachments.length > 0
              ? tr('common.pageSummary', '{{start}}-{{end}} of {{total}}', {
                  start: (currentPage - 1) * rowsPerPage + 1,
                  end: Math.min(currentPage * rowsPerPage, sortedVolumeAttachments.length),
                  total: sortedVolumeAttachments.length,
                })
              : tr('common.pageSummaryEmpty', '0 of 0')}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={currentPage <= 1}
              className="btn btn-secondary px-2 py-1 text-xs disabled:opacity-50"
            >
              {tr('common.prev', 'Previous')}
            </button>
            <span className="text-xs text-slate-300 min-w-[72px] text-center">{currentPage} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={currentPage >= totalPages}
              className="btn btn-secondary px-2 py-1 text-xs disabled:opacity-50"
            >
              {tr('common.next', 'Next')}
            </button>
          </div>
        </div>
      </div>

      {createDialogOpen && (
        <ResourceYamlCreateDialog
          title={tr('volumeattachments.createTitle', 'Create VolumeAttachment from YAML')}
          initialYaml={createVolumeAttachmentYamlTemplate}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['storage', 'volumeattachments'] })
          }}
        />
      )}
    </div>
  )
}
