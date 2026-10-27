// Dashboard "Quick actions" card — three buttons that open the
// Issues / Optimization / Storage modals. Extracted from
// Dashboard.tsx; the parent owns the modal state and passes click
// handlers down.

import { useTranslation } from 'react-i18next'
import { AlertCircle, Database, TrendingUp } from 'lucide-react'

interface Props {
  onOpenIssues: () => void
  onOpenOptimization: () => void
  onOpenStorage: () => void
}

export function DashboardQuickActions({ onOpenIssues, onOpenOptimization, onOpenStorage }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4">{tr('dashboard.quickActions.title', 'Quick actions')}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <button className="btn btn-secondary text-left" onClick={onOpenIssues}>
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-slate-400" aria-hidden="true" />
            <div>
              <div className="font-medium">{tr('dashboard.quickActions.issues.title', 'Check issues')}</div>
              <div className="text-xs text-slate-400">
                {tr('dashboard.quickActions.issues.subtitle', 'Find resources with problems')}
              </div>
            </div>
          </div>
        </button>
        <button className="btn btn-secondary text-left" onClick={onOpenOptimization}>
          <div className="flex items-center gap-3">
            <TrendingUp className="w-5 h-5 text-slate-400" aria-hidden="true" />
            <div>
              <div className="font-medium">{tr('dashboard.quickActions.optimization.title', 'Optimization suggestions')}</div>
              <div className="text-xs text-slate-400">
                {tr('dashboard.quickActions.optimization.subtitle', 'AI-powered resource optimization')}
              </div>
            </div>
          </div>
        </button>
        <button className="btn btn-secondary text-left" onClick={onOpenStorage}>
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-slate-400" aria-hidden="true" />
            <div>
              <div className="font-medium">{tr('dashboard.quickActions.storage.title', 'Storage analysis')}</div>
              <div className="text-xs text-slate-400">
                {tr('dashboard.quickActions.storage.subtitle', 'PV/PVC usage status')}
              </div>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}
