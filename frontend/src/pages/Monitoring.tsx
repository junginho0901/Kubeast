import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import MonitoringNodes from './monitoring/MonitoringNodes'
import MonitoringPods from './monitoring/MonitoringPods'

// Monitoring entry — tab routing + the "metrics unavailable" banner.
// The Nodes/Pods tabs each own their own queries, AI snapshot, and
// metrics-error handling. Namespace list is fetched here so it survives
// tab switches without a refetch.
export default function Monitoring() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'nodes' | 'pods'>('nodes')
  // a tab's last answer says the cluster serves no metrics.k8s.io: the notice, while the tab asks again each minute
  const [notServed, setNotServed] = useState(false)

  // Namespace list (used by the Pods tab dropdown). Lifted here so
  // switching tabs does not trigger a refetch.
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30000,
  })

  const handleMetricsUnavailable = useCallback((unavailable: boolean) => {
    setNotServed(unavailable)
  }, [])

  // sized to the screen: each tab's list fits its rows and footer in the space left, as the list pages do
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-6">
      {/* Header */}
      <div className="page-head items-start shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{t('monitoring.title')}</h1>
          <p className="mt-2 text-slate-400">{t('monitoring.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/60 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('nodes')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                activeTab === 'nodes'
                  ? 'bg-primary-600 text-white'
                  : 'text-slate-400 hover:text-ink hover:bg-slate-800'
              }`}
            >
              {t('monitoring.tabs.nodes')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('pods')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                activeTab === 'pods'
                  ? 'bg-primary-600 text-white'
                  : 'text-slate-400 hover:text-ink hover:bg-slate-800'
              }`}
            >
              {t('monitoring.tabs.pods')}
            </button>
          </div>
        </div>
      </div>

      {notServed && (
        <div className="shrink-0 rounded-lg border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
          {t('monitoring.metricsUnavailable', 'Metrics server not available for this cluster')}
        </div>
      )}

      {activeTab === 'nodes' ? (
        <MonitoringNodes onMetricsUnavailable={handleMetricsUnavailable} />
      ) : (
        <MonitoringPods
          onMetricsUnavailable={handleMetricsUnavailable}
          namespaces={namespaces}
        />
      )}
    </div>
  )
}
