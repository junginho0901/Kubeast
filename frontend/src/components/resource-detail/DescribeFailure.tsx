import { useTranslation } from 'react-i18next'

import { failureText } from '@/utils/failureText'

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
