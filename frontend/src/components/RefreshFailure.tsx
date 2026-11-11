import { useTranslation } from 'react-i18next'

import type { RefreshFailed } from '@/hooks/useRefresh'
import { formatTime, utcTitle } from '@/utils/time'

// Under a page's header while its last Refresh failed (hooks/useRefresh): when, and why. It does not say the rows are
// older: a list that follows the cluster live keeps changing whatever its Refresh did.
export function RefreshFailure({ failure, className = '' }: { failure: RefreshFailed | null; className?: string }) {
  const { t } = useTranslation()
  if (!failure) return null
  return (
    <p role="alert" data-testid="refresh-failed" title={utcTitle(failure.at) ?? undefined} className={`shrink-0 text-sm text-red-400 break-words ${className}`}>
      {t('common.refreshFailed', {
        defaultValue: 'Refresh failed at {{time}}: {{reason}}',
        time: formatTime(failure.at),
        reason: failure.reason,
      })}
    </p>
  )
}
