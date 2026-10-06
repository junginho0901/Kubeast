// Issues modal — aggregates problematic resources (Node /
// Deployment / PVC / Pod / Metrics) with a search box, severity
// summary chips, and a per-kind grouped list. Extracted from
// Dashboard.tsx; the parent owns the issue derivation (it depends on
// many query results) and passes the prepared lists down.

import { useTranslation } from 'react-i18next'
import { CheckCircle, RefreshCw, Search, X } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import type { IssueItem, IssueKind, IssueSeverity } from '../types'

interface Props {
  open: boolean
  onClose: () => void

  // Filter / search controls
  includeRestartHistory: boolean
  setIncludeRestartHistory: (b: boolean) => void
  searchQuery: string
  setSearchQuery: (q: string) => void

  // Derived data (parent computes these from query results)
  isLoading: boolean
  sortedIssues: IssueItem[]
  issuesByKind: Record<IssueKind, IssueItem[]>
  issuesSummary: { total: number; critical: number; warning: number; info: number }
}

export function IssuesModal({
  open,
  onClose,
  includeRestartHistory,
  setIncludeRestartHistory,
  searchQuery,
  setSearchQuery,
  isLoading,
  sortedIssues,
  issuesByKind,
  issuesSummary,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  if (!open) return null

  const issueKindLabels: Record<IssueKind, string> = {
    Node: tr('dashboard.issues.kind.node', 'Node'),
    Deployment: tr('dashboard.issues.kind.deployment', 'Deployment'),
    PVC: tr('dashboard.issues.kind.pvc', 'PVC'),
    Pod: tr('dashboard.issues.kind.pod', 'Pod'),
    Metrics: tr('dashboard.issues.kind.metrics', 'Metrics'),
  }

  const issueSeverityLabels: Record<IssueSeverity, string> = {
    critical: tr('dashboard.issues.severity.critical', 'CRITICAL'),
    warning: tr('dashboard.issues.severity.warning', 'WARNING'),
    info: tr('dashboard.issues.severity.info', 'INFO'),
  }

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
                  'Aggregates problematic resources based on Pod/Node/Deployment/PVC status.',
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
          </div>

          <label className="flex items-center justify-between gap-3 mb-4 p-3 rounded-lg border border-slate-700 bg-slate-900/20">
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
              {(['Node', 'Deployment', 'PVC', 'Pod', 'Metrics'] as IssueKind[]).map((kind) => {
                const items = issuesByKind[kind] ?? []
                if (items.length === 0) return null
                return (
                  <div key={kind} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-200">{issueKindLabels[kind] || kind}</h3>
                      <span className="text-xs text-slate-400">
                        {tr('dashboard.issues.count', '{{count}}', { count: items.length })}
                      </span>
                    </div>
                    <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                      {items.map((issue) => (
                        <div key={issue.id} className="p-3 bg-slate-900/20">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
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
                              </div>
                              <div className="mt-1 space-y-0.5">
                                {issue.namespace && (
                                  <p className="text-xs text-slate-400">
                                    <span className="font-medium">{tr('dashboard.labels.namespaceShort', 'ns:')}</span> {issue.namespace}
                                  </p>
                                )}
                                {issue.subtitle && (
                                  <p className="text-xs text-slate-400">{issue.subtitle}</p>
                                )}
                              </div>
                            </div>
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
