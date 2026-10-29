// The window a group box opens: every pod of the group's owner — the ones drawn apart too — from the Pods
// page's server page (owner, card colour, search, problems first), or the members of a PVC or PV group.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { api, type ResourceGraphNode } from '@/services/api'
import { ListPager } from '@/components/ListPager'
import { ModalOverlay } from '@/components/ModalOverlay'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import { formatAge, utcTitle } from '@/utils/time'
import { getStatusColor } from '../workloads/pods/podHelpers'
import { kindIcon } from './constants'

const ROWS = 20

type Health = 'ok' | 'warn' | 'error'

interface Props {
  group: ResourceGraphNode
  onClose: () => void
  onExpand: (id: string) => void
  onOpen: (target: { kind: string; name: string; namespace?: string }) => void
}

export function PodGroupList({ group, onClose, onExpand, onOpen }: Props) {
  const { t } = useTranslation()
  const [health, setHealth] = useState<Health | undefined>()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const isPods = group.kind === 'Pod'

  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(id)
  }, [search])
  useEffect(() => setPage(1), [q, health])

  const owner = `${group.ownerKind ?? ''}/${group.ownerName ?? ''}`
  const podPage = useQuery({
    queryKey: ['resource-graph-group', group.namespace, owner, health, q, page],
    queryFn: () => api.getPodPage({
      namespace: group.namespace, owner, health, q: q || undefined, sort: 'health', offset: (page - 1) * ROWS, limit: ROWS,
    }),
    enabled: isPods,
    refetchInterval: 5000,
  })

  // a PVC or PV group: its members, searched here
  const members = useMemo(() => {
    const all = group.members ?? []
    return q ? all.filter((m) => m.toLowerCase().includes(q.toLowerCase())) : all
  }, [group.members, q])

  const stats = podPage.data?.stats
  const total = isPods ? (podPage.data?.total ?? 0) : members.length
  const totalPages = Math.max(1, Math.ceil(total / ROWS))
  const rows = isPods ? podPage.data?.items ?? [] : []
  const memberRows = isPods ? [] : members.slice((page - 1) * ROWS, page * ROWS)

  useAIContext(isPods ? (podPage.data ? {
    source: 'PodGroupList',
    summary: `${group.ownerKind} ${group.ownerName} Pod 목록 — ${stats?.total ?? 0}개 (그래프 묶음 ${group.count}개)${health ? ` · ${health}` : ''}${q ? ` · 검색 "${q}"` : ''}`,
    data: {
      stats: stats ? { total: stats.total, health: stats.health, top_reasons: stats.top_reasons } : undefined,
      visible_items: rows.map((p) => ({
        kind: 'Pod', name: p.name, namespace: p.namespace, status: p.status, restarts: p.restart_count, node: p.node_name,
        _link: buildResourceLink('Pod', p.namespace, p.name),
      })),
    },
  } : null) : {
    source: 'PodGroupList',
    summary: `${group.kind} 묶음 ${group.name} — ${group.count}개`,
    data: { visible_items: memberRows.map((name) => ({ kind: group.kind, name, namespace: group.namespace || undefined })) },
  }, [isPods, podPage.data, stats, rows, group, health, q, memberRows])

  const chips: [Health | undefined, string, number | undefined, string][] = [
    [undefined, t('resourceGraph.group.all', 'All'), stats?.total, 'text-ink'],
    ['ok', t('resourceGraph.group.ok', 'Healthy'), stats?.health?.ok, 'text-emerald-300'],
    ['warn', t('resourceGraph.group.warn', 'Warning'), stats?.health?.warn, 'text-amber-300'],
    ['error', t('resourceGraph.group.error', 'Error'), stats?.health?.error, 'text-rose-300'],
  ]

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('resourceGraph.group.title', { defaultValue: '{{kind}} group', kind: group.kind })}
        data-testid="pod-group-list"
      >
        <div className="p-6 border-b border-slate-700 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xl">{kindIcon[group.kind] || '📄'}</span>
              <div className="min-w-0">
                <p className="text-xs text-slate-400">
                  {isPods ? `${group.ownerKind} · ${group.namespace}` : t('resourceGraph.group.title', { defaultValue: '{{kind}} group', kind: group.kind })}
                </p>
                <h2 className="text-xl font-semibold text-ink truncate">{isPods ? group.ownerName : group.name}</h2>
                <p className="text-sm text-slate-400">
                  {t('resourceGraph.group.inGraph', { defaultValue: '{{count}} in this box of the graph', count: group.count })}
                </p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg transition-colors" aria-label={t('common.close', 'Close')}>
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>
          {isPods && (
            <div className="flex flex-wrap gap-2" data-testid="pod-group-chips">
              {chips.map(([value, label, count, color]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setHealth(value)}
                  aria-pressed={health === value}
                  data-health={value ?? 'all'}
                  className={`h-8 px-3 rounded-lg border text-xs transition-colors ${
                    health === value ? 'border-primary-500 bg-primary-600 text-white' : `border-slate-600 bg-slate-700 hover:border-slate-500 ${color}`
                  }`}
                >
                  {label} {count ?? '-'}
                </button>
              ))}
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isPods ? t('resourceGraph.group.searchPods', 'Search name, node or IP') : t('resourceGraph.group.searchMembers', 'Search name')}
              aria-label={t('resourceGraph.group.search', 'Search this group')}
              className="w-full h-10 pl-10 pr-3 bg-slate-700 text-ink rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-800 text-slate-400 text-xs">
              <tr className="border-b border-slate-700">
                <th className="text-left py-2.5 px-4">{t('pods.table.name', 'Name')}</th>
                {isPods && (
                  <>
                    <th className="text-left py-2.5 px-4">{t('pods.table.status', 'Status')}</th>
                    <th className="text-left py-2.5 px-4">{t('pods.table.restarts', 'Restarts')}</th>
                    <th className="text-left py-2.5 px-4">{t('pods.table.node', 'Node')}</th>
                    <th className="text-left py-2.5 px-4">{t('pods.table.age', 'Age')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {isPods ? rows.map((p) => (
                <tr
                  key={`${p.namespace}/${p.name}`}
                  className="border-b border-slate-700/60 hover:bg-slate-700/40 cursor-pointer"
                  onClick={() => onOpen({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                  data-testid="pod-group-row"
                >
                  <td className="py-2 px-4 font-mono text-xs text-ink">{p.name}</td>
                  <td className="py-2 px-4"><span className={`badge ${getStatusColor(p.status || '-')}`}>{p.status || '-'}</span></td>
                  <td className="py-2 px-4 font-mono text-xs text-slate-300">{p.restart_count}</td>
                  <td className="py-2 px-4 font-mono text-xs text-slate-300">{p.node_name || '-'}</td>
                  <td className="py-2 px-4 text-xs text-slate-400" title={utcTitle(p.created_at)}>{p.created_at ? formatAge(p.created_at) : '-'}</td>
                </tr>
              )) : memberRows.map((name) => (
                <tr
                  key={name}
                  className="border-b border-slate-700/60 hover:bg-slate-700/40 cursor-pointer"
                  onClick={() => onOpen({ kind: group.kind, name, namespace: group.namespace || undefined })}
                  data-testid="pod-group-row"
                >
                  <td className="py-2 px-4 font-mono text-xs text-ink">{name}</td>
                </tr>
              ))}
              {(isPods ? rows.length === 0 && !podPage.isLoading : memberRows.length === 0) && (
                <TableEmptyRow colSpan={isPods ? 5 : 1} resource={isPods ? 'pods' : group.kind === 'PersistentVolume' ? 'persistentvolumes' : 'persistentvolumeclaims'} searching={!!q || !!health} />
              )}
            </tbody>
          </table>
        </div>

        <ListPager currentPage={page} totalPages={totalPages} total={total} rowsPerPage={ROWS} onPageChange={setPage} showPageSize={false} testId="pod-group-pager" />
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-700">
          {isPods && (
            <button type="button" className="btn btn-primary" onClick={() => onExpand(group.id)} data-testid="pod-group-expand">
              {t('resourceGraph.group.expand', 'Expand this group in the graph')}
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
