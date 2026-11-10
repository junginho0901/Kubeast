import { useTranslation } from 'react-i18next'

import type { RefreshFailed } from '@/hooks/useRefresh'
import { formatTime, utcTitle } from '@/utils/time'

// Under a page's header while its last Refresh failed (hooks/useRefresh): when, why, and that the rows are older.
export function RefreshFailure({ failure, className = '' }: { failure: RefreshFailed | null; className?: string }) {
  const { t } = useTranslation()
  if (!failure) return null
  return (
    <p role="alert" data-testid="refresh-failed" title={utcTitle(failure.at) ?? undefined} className={`shrink-0 text-sm text-red-400 break-words ${className}`}>
      {t('common.refreshFailed', {
        defaultValue: 'Refresh failed at {{time}}: {{reason}}. What is shown is from the read before.',
        time: formatTime(failure.at),
        reason: failure.reason,
      })}
    </p>
  )
}
