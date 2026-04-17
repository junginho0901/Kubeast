import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, RefreshCw, Search } from 'lucide-react'
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

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-800/50 border border-slate-700 p-3">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <select
            className="rounded bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-white"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            <option value="">{t('helmReleases.allNamespaces')}</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center flex-1 min-w-[240px] rounded bg-slate-900 border border-slate-600 px-2">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={t('helmReleases.searchPlaceholder')}
            className="flex-1 bg-transparent px-2 py-1.5 text-sm text-white outline-none"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {filtered.length > 0 && (
          <span className="text-xs text-slate-400">
            {t('helmReleases.matchCount', { count: filtered.length })}
          </span>
        )}
      </div>

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

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-800/20 py-16 text-center">
      <Package className="w-10 h-10 text-slate-500" />
      <div className="text-lg font-semibold text-white">{t('helmReleases.empty.title')}</div>
      <div className="max-w-md text-sm text-slate-400">
        {t('helmReleases.empty.description')}
      </div>
    </div>
  )
}
