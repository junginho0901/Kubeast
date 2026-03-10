import { useState, useRef, useEffect, useCallback } from 'react'
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

const ROW_HEIGHT = 41
const HEADER_HEIGHT = 41
const PAGINATION_HEIGHT = 44
const WARNING_HEIGHT = 44

export default function SearchResultTable({ results, maxDisplay = 500 }: Props) {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const containerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [pageSize, setPageSize] = useState(15)

  const calcPageSize = useCallback(() => {
    if (!containerRef.current) return
    const containerH = containerRef.current.clientHeight
    const overhead = HEADER_HEIGHT + PAGINATION_HEIGHT + (results.length > maxDisplay ? WARNING_HEIGHT : 0)
    const available = containerH - overhead
    const rows = Math.max(1, Math.floor(available / ROW_HEIGHT))
    setPageSize(rows)
  }, [results.length, maxDisplay])

  useEffect(() => {
    calcPageSize()
    const obs = new ResizeObserver(calcPageSize)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [calcPageSize])

  const sorted = [...results].sort((a, b) => {
    const va = a[sortKey] ?? ''
    const vb = b[sortKey] ?? ''
    const cmp = String(va).localeCompare(String(vb))
    return sortDir === 'asc' ? cmp : -cmp
  })

  const capped = Math.min(sorted.length, maxDisplay)
  const totalPages = Math.max(1, Math.ceil(capped / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageItems = sorted.slice(safePage * pageSize, Math.min((safePage + 1) * pageSize, maxDisplay))

  useEffect(() => { setPage(0) }, [results])

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
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      {results.length > maxDisplay && (
        <div className="shrink-0 mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
          {t('advancedSearch.tooManyResults', 'Found {{total}} results. Showing first {{max}}.', {
            total: results.length,
            max: maxDisplay,
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 rounded-xl border border-slate-700/50 overflow-hidden">
        <table className="w-full text-sm table-fixed">
          <thead>
            <tr className="bg-slate-800/95">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`px-4 py-2.5 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors ${col.className}`}
                  onClick={() => toggleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    <ArrowUpDown className={`w-3 h-3 ${sortKey === col.key ? 'text-sky-400' : 'text-slate-600'}`} />
                  </span>
                </th>
              ))}
              <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider w-24">
                {t('advancedSearch.colActions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {pageItems.map((item, i) => {
              const globalIdx = safePage * pageSize + i
              return (
                <tr
                  key={`${item.kind}-${item.namespace}-${item.name}-${i}`}
                  className="hover:bg-slate-700/30 transition-colors h-[41px]"
                >
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-700/50 text-xs font-medium text-slate-300">
                      {item.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-medium text-white truncate max-w-0">
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
                  <td className="px-4 py-2 text-slate-400 truncate">
                    {item.namespace && item.namespace !== '-' ? (
                      <button
                        onClick={() => openDetail({ kind: 'Namespace', name: item.namespace, rawJson: undefined })}
                        className="text-slate-400 hover:text-sky-400 hover:underline transition-colors"
                      >
                        {item.namespace}
                      </button>
                    ) : '-'}
                  </td>
                  <td className={`px-4 py-2 font-medium ${statusColor(item.status ?? '-')}`}>
                    {item.status}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{item.age}</td>
                  <td className="px-4 py-2 text-right">
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
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="shrink-0 flex items-center justify-between pt-2 px-1">
        <span className="text-xs text-slate-500">
          {t('advancedSearch.pageInfo', '{{start}}-{{end}} of {{total}}', {
            start: safePage * pageSize + 1,
            end: Math.min((safePage + 1) * pageSize, capped),
            total: capped,
          })}
          {totalPages > 1 && ` (${t('advancedSearch.page', 'Page {{current}} of {{total}}', { current: safePage + 1, total: totalPages })})`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
            className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
