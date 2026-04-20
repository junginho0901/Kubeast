import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, ExternalLink, Loader2, Package, RefreshCw, Search } from 'lucide-react'
import { api, type HelmReleaseSummary } from '@/services/api'

// Release mutations are rare (install/upgrade minutes apart) so we
// refetch on a relaxed cadence rather than subscribing to a watch
// stream. The server caches the same query for 30s anyway, so the
// extra poll costs one list-secrets on miss.
const REFETCH_INTERVAL_MS = 30_000

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

export default function HelmReleasesPage() {
  const { t } = useTranslation()
  const [namespace, setNamespace] = useState<string>('')
  const [q, setQ] = useState<string>('')
  const [nsOpen, setNsOpen] = useState(false)
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

  // Derive namespace dropdown from the release list itself — no need
  // for a separate /namespaces call, and it keeps the selector in sync
  // with what the user can actually pick.
  const namespaces = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) set.add(r.namespace)
    return Array.from(set).sort()
  }, [items])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{t('helmReleases.title')}</h1>
          <p className="text-slate-400 text-sm mt-1">{t('helmReleases.subtitle')}</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm text-white"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('helmReleases.refresh')}
        </button>
      </div>

      {/* Search + namespace filter — matches the Pods page layout
          (h-12 search on the left, CustomDropdown on the right) so the
          Helm list reads as part of the same family as other resource
          lists rather than a bespoke page. */}
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
        {/* Namespace dropdown — inline custom to match the h-12 trigger
            used by the workloads pages (CustomDropdown component is
            h-10 and would look short next to the search box). */}
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

      {filtered.length > 0 && (
        <div className="text-xs text-slate-400">
          {t('helmReleases.matchCount', { count: filtered.length })}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-300 text-left">
              <tr>
                <th className="px-3 py-2">{t('helmReleases.table.name')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.namespace')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.revision')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.status')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.chart')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.chartVersion')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.appVersion')}</th>
                <th className="px-3 py-2">{t('helmReleases.table.updated')}</th>
              </tr>
            </thead>
            <tbody className="bg-slate-900/40 divide-y divide-slate-800">
              {filtered.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className="hover:bg-slate-800/60">
                  <td className="px-3 py-2 text-white font-medium">
                    <Link
                      to={`/helm/releases/${encodeURIComponent(r.namespace)}/${encodeURIComponent(r.name)}`}
                      className="hover:text-primary-400"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.namespace}</td>
                  <td className="px-3 py-2 text-slate-300">{r.revision}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${statusBadge(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.chart || '-'}</td>
                  <td className="px-3 py-2 text-slate-300">{r.chartVersion || '-'}</td>
                  <td className="px-3 py-2 text-slate-300">{r.appVersion || '-'}</td>
                  <td className="px-3 py-2 text-slate-400">{formatUpdated(r.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 py-16 text-center">
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
