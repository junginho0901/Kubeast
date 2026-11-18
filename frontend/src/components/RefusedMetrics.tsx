import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'

import { forbiddenResourceFromUrl } from '@/utils/forbiddenResource'

// The cluster refused a metrics read: no permission, with the cluster's reason. The Dashboard's top resources
// (pages/dashboard/topResourcesRead) and Monitoring's tabs (pages/monitoring/metricsRefresh) ask it no more until the
// page is opened again or another cluster is chosen.
export function RefusedMetrics({ path, reason, testId }: { path: string; reason?: string; testId: string }) {
  const { t } = useTranslation()
  return (
    <div className="text-center py-12" data-testid={testId}>
      <div className="flex flex-col items-center gap-2">
        <ShieldAlert className="w-8 h-8 text-notice-icon-warning" />
        <p className="text-notice-text-empty">
          {t('common.forbiddenEmpty', { resource: forbiddenResourceFromUrl(path), defaultValue: 'You do not have permission to view {{resource}} in this cluster.' })}
        </p>
        {reason && <p className="text-xs text-notice-text-muted break-words">{reason}</p>}
      </div>
    </div>
  )
}
