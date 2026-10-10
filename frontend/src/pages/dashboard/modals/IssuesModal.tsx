// Issues modal — the rows of /api/v1/cluster/issues (pods, workloads, nodes,
// PVCs, Warning events of the last window) grouped per kind, with a search
// box, severity chips, the events window and the restart-history toggle.
// The parent owns the query and the derived lists; a row opens the drawer.

import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle, RefreshCw, Search, X } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import type { IssueItem, IssueKind, IssueSeverity } from '../types'
import { formatAge } from '../utils'

interface Props {
  open: boolean
  onClose: () => void

  // Filter / search controls
  includeRestartHistory: boolean
  setIncludeRestartHistory: (b: boolean) => void
  windowMinutes: number | null
  setWindowMinutes: (m: number | null) => void
  defaultWindowMinutes: number
  searchQuery: string
  setSearchQuery: (q: string) => void

  // Derived data (parent computes these from the query result)
  isLoading: boolean
  error?: string
  generatedAt?: string
  sortedIssues: IssueItem[]
  issuesByKind: Record<IssueKind, IssueItem[]>
  kinds: IssueKind[]
  issuesSummary: { total: number; critical: number; warning: number; info: number }
  onOpenIssue: (issue: IssueItem) => void
}

export function IssuesModal({
  open,
  onClose,
  includeRestartHistory,
  setIncludeRestartHistory,
  windowMinutes,
  setWindowMinutes,
  defaultWindowMinutes,
  searchQuery,
  setSearchQuery,
  isLoading,
  error,
  generatedAt,
  sortedIssues,
  issuesByKind,
  kinds,
  issuesSummary,
  onOpenIssue,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  if (!open) return null

  const kindLabel = (kind: IssueKind) => tr(`dashboard.issues.kind.${kind.toLowerCase()}`, kind)

  const issueSeverityLabels: Record<IssueSeverity, string> = {
    critical: tr('dashboard.issues.severity.critical', 'CRITICAL'),
    warning: tr('dashboard.issues.severity.warning', 'WARNING'),
    info: tr('dashboard.issues.severity.info', 'INFO'),
  }

  const effectiveWindow = windowMinutes ?? defaultWindowMinutes
  const windowOptions = Array.from(new Set([defaultWindowMinutes, 60, 360, 1440])).sort((a, b) => a - b)
  const windowLabel = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`)
  const nowMs = Date.now()

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-white">{tr('dashboard.issues.title', 'Issues')}</h2>
              <p className="text-sm text-slate-400">
                {tr(
                  'dashboard.issues.subtitle',
                  'Pods, workloads, nodes, PVCs and the Warning events of the last {{window}}, with the reason and the last message.',
                  { window: windowLabel(effectiveWindow) },
                )}
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
            <span className="text-xs text-slate-400">{tr('dashboard.issues.totalLabel', 'Total')}</span>
            <span className="badge badge-info">{tr('dashboard.issues.totalCount', '{{count}}', { count: issuesSummary.total })}</span>
            <span className="badge badge-error">{tr('dashboard.issues.criticalLabel', 'Critical')} {issuesSummary.critical}</span>
            <span className="badge badge-warning">{tr('dashboard.issues.warningLabel', 'Warning')} {issuesSummary.warning}</span>
            <span className="badge badge-info">{tr('dashboard.issues.infoLabel', 'Info')} {issuesSummary.info}</span>
            {generatedAt && (
              <span className="text-xs text-slate-500 ml-auto">
                {tr('dashboard.issues.generatedAt', 'Collected {{age}} ago', { age: formatAge(nowMs - Date.parse(generatedAt)) })}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-3 mb-4 sm:flex-row sm:items-stretch">
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-700 bg-slate-900/20 sm:w-72">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200">{tr('dashboard.issues.window', 'Events window')}</p>
                <p className="text-xs text-slate-400 truncate">
                  {tr('dashboard.issues.windowHint', 'Warning events newer than this are attached to their object.')}
                </p>
              </div>
              <div className="flex items-center gap-1" role="group" aria-label={tr('dashboard.issues.window', 'Events window')}>
                {windowOptions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`issues-window-${m}`}
                    aria-pressed={m === effectiveWindow}
                    onClick={() => setWindowMinutes(m === defaultWindowMinutes ? null : m)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${m === effectiveWindow ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    {windowLabel(m)}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-1 items-center justify-between gap-3 p-3 rounded-lg border border-slate-700 bg-slate-900/20">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200">
                  {tr('dashboard.issues.includeRestarts', 'Include restart history')}
                </p>
                <p className="text-xs text-slate-400 truncate">
                  {tr(
                    'dashboard.issues.includeRestartsHint',
                    'Include past restarts for currently healthy (Running/Ready) pods as Info.',
                  )}
                </p>
              </div>
              <input
                type="checkbox"
                checked={includeRestartHistory}
                onChange={(e) => setIncludeRestartHistory(e.target.checked)}
                className="h-4 w-4 rounded-sm border-slate-600 bg-slate-700 text-primary-500 focus:ring-primary-500"
              />
            </label>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('dashboard.issues.searchPlaceholder', 'Search issues (name/namespace/message)...')}
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
              <p className="text-slate-400">{tr('dashboard.issues.loading', 'Collecting issues...')}</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[240px]" data-testid="issues-error">
              <AlertCircle className="w-9 h-9 text-red-400 mb-3" />
              <p className="text-slate-300 font-medium">{tr('dashboard.issues.error', 'Failed to collect issues')}</p>
              <p className="text-sm text-slate-400 mt-1 wrap-break-word">{error}</p>
            </div>
          ) : sortedIssues.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
              <CheckCircle className="w-9 h-9 text-green-400 mb-3" />
              <p className="text-slate-300 font-medium">{tr('dashboard.issues.none', 'No issues detected')}</p>
              <p className="text-sm text-slate-400 mt-1">
                {tr('dashboard.issues.noneHint', 'Check your filters/search terms')}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {kinds.map((kind) => {
                const items = issuesByKind[kind] ?? []
                if (items.length === 0) return null
                const openable = kind !== 'Collector'
                return (
                  <div key={kind} className="space-y-2" data-testid={`issues-kind-${kind}`}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-200">{kindLabel(kind)}</h3>
                      <span className="text-xs text-slate-400">
                        {tr('dashboard.issues.count', '{{count}}', { count: items.length })}
                      </span>
                    </div>
                    <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                      {items.map((issue) => (
                        <div
                          key={issue.id}
                          data-testid="issue-row"
                          role={openable ? 'button' : undefined}
                          tabIndex={openable ? 0 : undefined}
                          onClick={openable ? () => onOpenIssue(issue) : undefined}
                          onKeyDown={openable ? (e) => { if (e.key === 'Enter') onOpenIssue(issue) } : undefined}
                          title={openable ? tr('dashboard.issues.openHint', 'Open details') : undefined}
                          className={`p-3 bg-slate-900/20 ${openable ? 'cursor-pointer hover:bg-slate-700/40 transition-colors' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`badge ${issue.severity === 'critical'
                                      ? 'badge-error'
                                      : issue.severity === 'warning'
                                        ? 'badge-warning'
                                        : 'badge-info'
                                    }`}
                                >
                                  {issueSeverityLabels[issue.severity] || issue.severity.toUpperCase()}
                                </span>
                                <p className="text-sm font-medium text-white truncate">
                                  {issue.title}
                                </p>
                                {issue.namespace && (
                                  <span className="text-xs text-slate-400">
                                    <span className="font-medium">{tr('dashboard.labels.namespaceShort', 'ns:')}</span> {issue.namespace}
                                  </span>
                                )}
                              </div>
                              {issue.subtitle && (
                                <p className="mt-1 text-xs text-slate-400 line-clamp-2 wrap-break-word">{issue.subtitle}</p>
                              )}
                            </div>
                            {(issue.lastSeen || issue.count) && (
                              <div className="shrink-0 text-right text-xs text-slate-500 space-y-0.5">
                                {issue.lastSeen && (
                                  <p>{tr('dashboard.issues.lastSeen', 'last {{age}} ago', { age: formatAge(nowMs - Date.parse(issue.lastSeen)) })}</p>
                                )}
                                {!!issue.count && issue.count > 1 && (
                                  <p>{tr('dashboard.issues.countTimes', '×{{count}}', { count: issue.count })}</p>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
