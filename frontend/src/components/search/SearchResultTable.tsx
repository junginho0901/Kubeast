import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, ChevronLeft, ChevronRight, Copy, Check, ArrowUpDown } from 'lucide-react'
import { SearchResult } from './searchEngine'
import { useResourceDetail } from '@/components/ResourceDetailContext'

interface Props {
  results: SearchResult[]
  maxDisplay?: number
}

type SortKey = 'kind' | 'name' | 'namespace' | 'status' | 'age'
type SortDir = 'asc' | 'desc'

export default function SearchResultTable({ results, maxDisplay = 200 }: Props) {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const [page, setPage] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const pageSize = 50

  const sorted = [...results].sort((a, b) => {
    const va = a[sortKey] ?? ''
    const vb = b[sortKey] ?? ''
    const cmp = String(va).localeCompare(String(vb))
    return sortDir === 'asc' ? cmp : -cmp
  })

  const totalPages = Math.ceil(Math.min(sorted.length, maxDisplay) / pageSize)
  const pageItems = sorted.slice(page * pageSize, Math.min((page + 1) * pageSize, maxDisplay))

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
    setPage(0)
  }

  const copyName = (name: string, idx: number) => {
    navigator.clipboard.writeText(name)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1500)
  }

  const columns: { key: SortKey; label: string; className: string }[] = [
    { key: 'kind', label: t('advancedSearch.colKind', 'Kind'), className: 'w-32' },
    { key: 'name', label: t('advancedSearch.colName', 'Name'), className: 'flex-1 min-w-0' },
    { key: 'namespace', label: t('advancedSearch.colNamespace', 'Namespace'), className: 'w-40' },
    { key: 'status', label: t('advancedSearch.colStatus', 'Status'), className: 'w-28' },
    { key: 'age', label: t('advancedSearch.colAge', 'Age'), className: 'w-20' },
  ]

  const statusColor = (s: string) => {
    const lower = s.toLowerCase()
    if (['running', 'ready', 'active', 'bound', 'succeeded', 'available'].some(k => lower.includes(k)))
      return 'text-emerald-400'
    if (['pending', 'waiting', 'creating'].some(k => lower.includes(k)))
      return 'text-amber-400'
    if (['failed', 'error', 'crashloop', 'notready', 'terminating'].some(k => lower.includes(k)))
      return 'text-red-400'
    return 'text-slate-400'
  }

  if (results.length === 0) return null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {results.length > maxDisplay && (
        <div className="mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
          {t('advancedSearch.tooManyResults', 'Found {{total}} results. Showing first {{max}}.', {
            total: results.length,
            max: maxDisplay,
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-slate-700/50">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-800/95 backdrop-blur">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors ${col.className}`}
                  onClick={() => toggleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    <ArrowUpDown className={`w-3 h-3 ${sortKey === col.key ? 'text-sky-400' : 'text-slate-600'}`} />
                  </span>
                </th>
              ))}
              <th className="px-4 py-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider w-24">
                {t('advancedSearch.colActions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {pageItems.map((item, i) => {
              const globalIdx = page * pageSize + i
              return (
                <tr
                  key={`${item.kind}-${item.namespace}-${item.name}-${i}`}
                  className="hover:bg-slate-700/30 transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-700/50 text-xs font-medium text-slate-300">
                      {item.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-white truncate max-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={() => openDetail({
                          kind: item.kind,
                          name: item.name,
                          namespace: item.namespace || undefined,
                          rawJson: item.raw,
                        })}
                        className="truncate text-sky-400 hover:text-sky-300 hover:underline transition-colors text-left"
                      >
                        {item.name}
                      </button>
                      <button
                        onClick={() => copyName(item.name, globalIdx)}
                        className="flex-shrink-0 p-0.5 text-slate-500 hover:text-white transition-colors"
                        title="Copy name"
                      >
                        {copiedIdx === globalIdx ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 truncate">
                    {item.namespace ? (
                      <button
                        onClick={() => openDetail({ kind: 'Namespace', name: item.namespace, rawJson: undefined })}
                        className="text-slate-400 hover:text-sky-400 hover:underline transition-colors"
                      >
                        {item.namespace}
                      </button>
                    ) : '-'}
                  </td>
                  <td className={`px-4 py-2.5 font-medium ${statusColor(item.status ?? '-')}`}>
                    {item.status}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{item.age}</td>
                  <td className="px-4 py-2.5 text-right">
                    {(
                      <button
                        onClick={() => openDetail({
                          kind: item.kind,
                          name: item.name,
                          namespace: item.namespace || undefined,
                          rawJson: item.raw,
                        })}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Detail
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 px-1">
          <span className="text-xs text-slate-500">
            {t('advancedSearch.page', 'Page {{current}} of {{total}}', { current: page + 1, total: totalPages })}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
