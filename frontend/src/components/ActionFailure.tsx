import { useTranslation } from 'react-i18next'

import { failureText } from '@/utils/failureText'

export type FailedAction = 'delete' | 'save' | 'change' | 'revoke' | 'end' | 'cancel' | 'rollback' | 'download'

const FALLBACK: Record<FailedAction, string> = {
  download: 'Not downloaded: {{reason}}',
  delete: 'Not deleted: {{reason}}',
  save: 'Not saved: {{reason}}',
  change: 'Not changed: {{reason}}',
  revoke: 'Not revoked: {{reason}}',
  end: 'Not ended: {{reason}}',
  cancel: 'Not cancelled: {{reason}}',
  rollback: 'Not rolled back: {{reason}}',
}

// An action the server refused, said where it was pressed with the server's reason (utils/failureText). It stays
// until the next try clears the error (a mutation's reset or its next run).
export function ActionFailure({ error, action, testId, className = '' }: { error: unknown; action: FailedAction; testId?: string; className?: string }) {
  const { t } = useTranslation()
  if (!error) return null
  return (
    <p role="alert" data-testid={testId} className={`text-sm text-red-400 break-words ${className}`}>
      {t(`common.failed.${action}`, { defaultValue: FALLBACK[action], reason: failureText(error) })}
    </p>
  )
}
