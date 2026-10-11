// Dashboard page header — title / subtitle / cluster version line +
// Refresh button. Extracted from Dashboard.tsx; the parent passes the
// cluster version (when known) and the refresh handler/spinner state.

import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

interface Props {
  clusterVersion?: string
  isRefreshing: boolean
  onRefresh: () => void
}

export function DashboardHeader({ clusterVersion, isRefreshing, onRefresh }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-3xl font-bold text-white">{tr('dashboard.title', 'Cluster Dashboard')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('dashboard.subtitle', 'Get a quick overview of your Kubernetes cluster.')}
        </p>
        {clusterVersion && (
          <p className="mt-1 text-sm text-slate-500">
            {tr('dashboard.clusterVersion', 'Cluster version: {{version}}', { version: clusterVersion })}
          </p>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={isRefreshing}
        title={tr('dashboard.refreshTitle', 'Force refresh')}
        className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        {tr('dashboard.refresh', 'Refresh')}
      </button>
    </div>
  )
}
