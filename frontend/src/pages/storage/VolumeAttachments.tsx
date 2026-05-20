import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type VolumeAttachmentInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ResourceYamlCreateDialog from '@/components/ResourceYamlCreateDialog'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { usePermission } from '@/hooks/usePermission'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { buildResourceLink } from '@/utils/resourceLink'
import { Plus, RefreshCw } from 'lucide-react'
import {
  parseAgeSeconds,
  statusLabel,
  type SortKey,
  type SummaryCard,
} from './volumeattachments/volumeAttachmentHelpers'
import { applyVolumeAttachmentWatchEvent } from './volumeattachments/volumeAttachmentWatchNormalize'
import { VolumeAttachmentFilters } from './volumeattachments/VolumeAttachmentFilters'
import { VolumeAttachmentTable } from './volumeattachments/VolumeAttachmentTable'

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

      <VolumeAttachmentFilters
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchPlaceholder={tr('volumeattachments.searchPlaceholder', 'Search VolumeAttachments by name, PV, node, or attacher...')}
      />

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

        <VolumeAttachmentTable
          pagedVolumeAttachments={pagedVolumeAttachments}
          sortedVolumeAttachmentsLength={sortedVolumeAttachments.length}
          isLoading={isLoading}
          sortKey={sortKey}
          setSortKey={setSortKey}
          sortDir={sortDir}
          setSortDir={setSortDir}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          totalPages={totalPages}
          rowsPerPage={rowsPerPage}
          tableBodyRef={tableBodyRef}
          theadRef={theadRef}
          firstRowRef={firstRowRef}
          openDetail={openDetail}
          tr={tr}
        />
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
