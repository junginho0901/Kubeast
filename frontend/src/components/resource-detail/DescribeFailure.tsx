import { useTranslation } from 'react-i18next'

import { failureText } from '@/utils/failureText'
import { formatTime } from '@/utils/time'

// A drawer's own read (describe) that failed, said where its fields would be with the server's reason — a refusal
// (403) names what the cluster would not let this identity read. Where the drawer still draws the list's row it says
// so, so a field it could not read is not taken for one the object does not have.
export function DescribeFailure({ error, showingRow = false, className = '' }: { error: unknown; showingRow?: boolean; className?: string }) {
  const { t } = useTranslation()
  if (!error) return null
  const reason = failureText(error)
  return (
    <p role="alert" data-testid="describe-failed" className={`text-xs text-red-400 break-words ${className}`}>
      {showingRow
        ? t('common.describeFailedRow', { reason, defaultValue: "Could not read the details: {{reason}} Showing what the list's row holds." })
        : t('common.describeFailed', { reason, defaultValue: 'Could not read the details: {{reason}}' })}
    </p>
  )
}

// A list the drawer reads beside its object (the pods of a namespace, the Ingresses of a class) that failed: the reason
// where the rows would be, never "None" or a count of 0.
export function ListReadFailure({ error, testId = 'list-read-failed' }: { error: unknown; testId?: string }) {
  const { t } = useTranslation()
  if (!error) return null
  return (
    <p role="alert" data-testid={testId} className="text-xs text-red-400 break-words">
      {t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason: failureText(error) })}
    </p>
  )
}

// A drawer that follows its object and whose read again failed: it keeps what it read, and says so with the reason and
// when that was read — as a list's RefreshFailure does — instead of showing the old answer as the object now.
export function DescribeStale({ error, readAt }: { error: unknown; readAt: number }) {
  const { t } = useTranslation()
  if (!error || !readAt) return null
  return (
    <p role="alert" data-testid="describe-stale" className="mb-2 text-xs text-amber-300 break-words">
      {t('common.describeRefreshFailed', {
        reason: failureText(error),
        time: formatTime(readAt),
        defaultValue: 'Could not read the details again: {{reason}} What shows was read at {{time}}.',
      })}
    </p>
  )
}
