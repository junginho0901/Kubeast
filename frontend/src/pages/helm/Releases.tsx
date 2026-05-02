import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  Search,
} from 'lucide-react'
import { api, type HelmReleaseSummary } from '@/services/api'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useAIContext } from '@/hooks/useAIContext'
import { summarizeList } from '@/utils/aiContext/summarizeList'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'

// Release mutations are rare (install/upgrade minutes apart) so we
// refetch on a relaxed cadence rather than subscribing to a watch
// stream. The server caches the same query for 30s anyway, so the
// extra poll costs one list-secrets on miss.
const REFETCH_INTERVAL_MS = 30_000

type SortKey = null | 'name' | 'namespace' | 'revision' | 'status' | 'chart' | 'chartVersion' | 'appVersion' | 'updated'
type SortDir = 'asc' | 'desc'

function formatUpdated(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function statusBadge(status: string): string {
  const s = status.toLowerCase()
  if (s === 'deployed') return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
  if (s === 'failed') return 'bg-red-500/15 text-red-300 border border-red-500/30'
  if (s.startsWith('pending')) return 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
  if (s === 'superseded') return 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
  if (s.startsWith('uninstall')) return 'bg-slate-600/40 text-slate-300 border border-slate-600'
  return 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
}

type SummaryCard = [label: string, value: number, boxClass: string, labelClass: string]

export default function HelmReleasesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [namespace, setNamespace] = useState<string>('')
  const [q, setQ] = useState<string>('')
  const [nsOpen, setNsOpen] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const nsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!nsOpen) return
    const onClick = (e: MouseEvent) => {
      if (nsRef.current && !nsRef.current.contains(e.target as Node)) setNsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [nsOpen])

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['helm-releases', namespace],
    queryFn: () => api.helm.listReleases(namespace ? { namespace } : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: REFETCH_INTERVAL_MS,
    staleTime: REFETCH_INTERVAL_MS / 2,
  })

  const items: HelmReleaseSummary[] = data ?? []

  // Client-side name filtering only — the server already narrows by
  // namespace which is the big cardinality reducer. Keeping the text
  // filter local means typing does not thrash the API.
  const filtered = useMemo(() => {
    if (!q.trim()) return items
    const needle = q.trim().toLowerCase()
    return items.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.chart.toLowerCase().includes(needle),
    )
  }, [items, q])

  // Stats count across *unfiltered* items so the header numbers stay
  // stable while the user narrows the table with the search box.
  const stats = useMemo(() => {
    let total = 0
    let deployed = 0
    let failed = 0
    let pending = 0
    let superseded = 0
    for (const r of items) {
      total += 1
      const s = r.status.toLowerCase()
      if (s === 'deployed') deployed += 1
      else if (s === 'failed') failed += 1
      else if (s.startsWith('pending')) pending += 1
      else if (s === 'superseded') superseded += 1
    }
    return { total, deployed, failed, pending, superseded }
  }, [items])

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      [t('helmReleases.stats.total'), stats.total, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
      [t('helmReleases.stats.deployed'), stats.deployed, 'border-emerald-700/40 bg-emerald-900/10', 'text-emerald-300'],
      [t('helmReleases.stats.failed'), stats.failed, 'border-rose-700/40 bg-rose-900/10', 'text-rose-300'],
      [t('helmReleases.stats.pending'), stats.pending, 'border-amber-700/40 bg-amber-900/10', 'text-amber-300'],
      [t('helmReleases.stats.superseded'), stats.superseded, 'border-slate-700 bg-slate-900/50', 'text-slate-400'],
    ],
    [stats, t],
  )

  // Derive namespace dropdown from the release list itself — no need
  // for a separate /namespaces call, and it keeps the selector in sync
  // with what the user can actually pick.
  const namespaces = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) set.add(r.namespace)
    return Array.from(set).sort()
  }, [items])

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
    // Third click on same column clears the sort — returns natural order.
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3.5 h-3.5 text-slate-300" />
      : <ChevronDown className="w-3.5 h-3.5 text-slate-300" />
  }

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const list = [...filtered]
    const getValue = (r: HelmReleaseSummary): string | number => {
      switch (sortKey) {
        case 'name':
          return r.name
        case 'namespace':
          return r.namespace
        case 'revision':
          return r.revision
        case 'status':
          return r.status
        case 'chart':
          return r.chart
        case 'chartVersion':
          return r.chartVersion
        case 'appVersion':
          return r.appVersion
        case 'updated':
          return r.updated ? new Date(r.updated).getTime() : 0
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
      const as = String(av)
      const bs = String(bv)
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
    return list
  }, [filtered, sortKey, sortDir])

  const { containerRef: tableContainerRef, bodyRef: tableBodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({
    recalculationKey: sorted.length,
  })
  const totalPages = Math.max(1, Math.ceil(sorted.length / rowsPerPage))

  // Reset to page 1 when filters change so the user isn't stranded on
  // an out-of-range page after the result set shrinks.
  useEffect(() => {
    setCurrentPage(1)
  }, [q, namespace])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const paged = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage
    return sorted.slice(start, start + rowsPerPage)
  }, [sorted, currentPage, rowsPerPage])

  // 플로팅 AI 위젯용 스냅샷
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
        filters: { namespace: namespace || undefined, search: q || undefined },
        stats: { total, deployed, pending, failed },
        ...summarizeList(paged as unknown as Record<string, unknown>[], {
          total: sorted.length,
          currentPage,
          pageSize: rowsPerPage,
          topN: rowsPerPage,
          pickFields: ['name', 'namespace', 'revision', 'status', 'chart', 'chart_version', 'app_version', 'updated'],
          filterProblematic: (r) => /fail|error/i.test(String((r as unknown as HelmReleaseSummary).status)),
        }),
      },
    }
  }, [items, paged, sorted.length, currentPage, rowsPerPage, namespace, q])

  useAIContext(aiSnapshot, [aiSnapshot])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">{t('helmReleases.title')}</h1>
          <p className="mt-2 text-slate-400">{t('helmReleases.subtitle')}</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('helmReleases.refresh')}
        </button>
      </div>

      {/* Search + namespace filter */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={t('helmReleases.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="relative" ref={nsRef}>
          <button
            type="button"
            onClick={() => setNsOpen(!nsOpen)}
            className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium truncate">
              {namespace === '' ? t('helmReleases.allNamespaces') : namespace}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform ${nsOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {nsOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[260px] overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setNamespace('')
                  setNsOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
              >
                {namespace === '' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={namespace === '' ? 'font-medium' : ''}>
                  {t('helmReleases.allNamespaces')}
                </span>
              </button>
              {namespaces.map((ns) => (
                <button
                  key={ns}
                  type="button"
                  onClick={() => {
                    setNamespace(ns)
                    setNsOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {namespace === ns && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  <span className={namespace === ns ? 'font-medium' : ''}>{ns}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stats row — counts come from full items, not filtered, so the
          header numbers stay stable when the search input narrows the
          table. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
        {summaryCards.map(([label, value, boxClass, labelColor]) => (
          <div key={label} className={`rounded-lg border px-3 py-2.5 ${boxClass}`}>
            <div className={`text-[11px] sm:text-xs leading-4 whitespace-nowrap ${labelColor}`}>{label}</div>
            <div className="mt-1 text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 flex-1">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-start">
          <EmptyState />
        </div>
      ) : (
        <div ref={tableContainerRef} className="card flex-1 min-h-0 flex flex-col">
          <div ref={tableBodyRef} className="overflow-x-auto flex-1 min-h-0">
            <table className="w-full text-sm table-fixed">
              <thead ref={theadRef} className="text-slate-400">
                <tr>
                  <th className="text-left py-3 px-4 w-[200px] cursor-pointer" onClick={() => handleSort('name')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.name')}{renderSortIcon('name')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[140px] cursor-pointer" onClick={() => handleSort('namespace')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.namespace')}{renderSortIcon('namespace')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[90px] cursor-pointer" onClick={() => handleSort('revision')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.revision')}{renderSortIcon('revision')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[130px] cursor-pointer" onClick={() => handleSort('status')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.status')}{renderSortIcon('status')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('chart')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.chart')}{renderSortIcon('chart')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('chartVersion')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.chartVersion')}{renderSortIcon('chartVersion')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[120px] cursor-pointer" onClick={() => handleSort('appVersion')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.appVersion')}{renderSortIcon('appVersion')}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 w-[180px] cursor-pointer" onClick={() => handleSort('updated')}>
                    <span className="inline-flex items-center gap-1">
                      {t('helmReleases.table.updated')}{renderSortIcon('updated')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {paged.map((r, idx) => {
                  const to = `/helm/releases/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`
                  return (
                    <tr
                      key={`${r.namespace}/${r.name}`}
                      ref={idx === 0 ? firstRowRef : undefined}
                      className="text-slate-200 hover:bg-slate-800/60 cursor-pointer"
                      onClick={() => navigate(to)}
                    >
                      <td className="py-3 px-4 font-medium text-white">
                        {/* Link kept for cmd/middle-click new-tab;
                            stopPropagation so the row onClick does not
                            double-fire. */}
                        <Link to={to} className="hover:text-primary-400" onClick={(e) => e.stopPropagation()}>
                          <span className="block truncate">{r.name}</span>
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-xs font-mono"><span className="block truncate">{r.namespace}</span></td>
                      <td className="py-3 px-4 text-xs font-mono">{r.revision}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${statusBadge(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-xs"><span className="block truncate">{r.chart || '-'}</span></td>
                      <td className="py-3 px-4 text-xs font-mono">{r.chartVersion || '-'}</td>
                      <td className="py-3 px-4 text-xs font-mono">{r.appVersion || '-'}</td>
                      <td className="py-3 px-4 text-xs font-mono text-slate-400">{formatUpdated(r.updated)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <AdaptiveTableFillerRows count={rowsPerPage - paged.length} columnCount={8} />
            </table>
          </div>
          {sorted.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700 shrink-0">
              <div className="text-xs text-slate-400">
                {t('common.paginationRange', {
                  start: (currentPage - 1) * rowsPerPage + 1,
                  end: Math.min(currentPage * rowsPerPage, sorted.length),
                  total: sorted.length,
                  defaultValue: 'Showing {{start}}-{{end}} of {{total}}',
                })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
                >
                  {t('common.prev', { defaultValue: 'Prev' })}
                </button>
                <span className="text-xs text-slate-300 min-w-[72px] text-center">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed hover:text-white hover:border-slate-500"
                >
                  {t('common.next', { defaultValue: 'Next' })}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Empty state buttons point at Helm's public docs. The "install guide"
// link targets the subchapter most useful to a first-time user
// ("Installing Apps with Helm") rather than the manpage index.
const HELM_DOCS_URL = 'https://helm.sh/docs/'
const HELM_INSTALL_GUIDE_URL = 'https://helm.sh/docs/intro/using_helm/'

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="w-full flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 py-16 text-center">
      <Package className="w-10 h-10 text-slate-500" />
      <div className="text-lg font-semibold text-white">{t('helmReleases.empty.title')}</div>
      <div className="max-w-md text-sm text-slate-400">
        {t('helmReleases.empty.description')}
      </div>
      <div className="flex gap-2 mt-2">
        <a
          href={HELM_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
        >
          {t('helmReleases.empty.docs')}
          <ExternalLink className="w-3 h-3" />
        </a>
        <a
          href={HELM_INSTALL_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
        >
          {t('helmReleases.empty.installGuide')}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  )
}
