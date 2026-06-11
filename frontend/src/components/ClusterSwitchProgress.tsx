import { useTranslation } from 'react-i18next'

import { useCluster } from '@/contexts/ClusterContext'

// Global cluster-switch indicator. When the user switches clusters the
// cluster-scoped query cache is cleared and refetched against the new (often
// remote, slower) cluster — without a signal the UI looks frozen. This shows a
// pulsing top bar + a small pill over the content for the duration of the
// switch (driven by ClusterContext.isSwitching), so the switch is obviously
// "working". Renders nothing when not switching.
export default function ClusterSwitchProgress() {
  const { isSwitching, currentCluster } = useCluster()
  const { t } = useTranslation()

  if (!isSwitching) return null

  return (
    <>
      {/* indeterminate top bar — a segment slides across the track */}
      <div className="fixed top-0 left-64 right-0 z-50 h-1 overflow-hidden bg-primary-900/40">
        <div className="absolute top-0 h-full rounded-full bg-primary-500 animate-indeterminate-bar" />
      </div>
      {/* status pill (carries the testid — it has real dimensions) */}
      <div
        data-testid="cluster-switch-progress"
        aria-live="polite"
        className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-slate-700 bg-slate-800/95 px-3 py-1.5 text-xs text-slate-200 shadow-lg"
      >
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        <span>{t('cluster.switching', 'Switching to {{cluster}}…', { cluster: currentCluster })}</span>
      </div>
    </>
  )
}
