import { useTranslation } from 'react-i18next'

import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { failureText } from '@/utils/failureText'
import { formatTime } from '@/utils/time'

// The object a drawer notice is about, as its header names it: the open drawer's, unless the notice says another (a
// VPA's target, the Cluster View pod window, which no drawer holds).
export type NoticeObject = { kind: string; name: string; namespace?: string }

function useNoticeObject(about?: NoticeObject): NoticeObject | null {
  const target = useResourceDetail()?.target
  const object = about ?? (target ? { kind: target.kind, name: target.name, namespace: target.namespace } : null)
  if (!object?.kind || !object.name) return null
  return { kind: object.kind, name: object.name, ...(object.namespace ? { namespace: object.namespace } : {}) }
}

// The layer a drawer notice tells the floating chat: its words and what they are about.
function useNoticeLayer(source: string, text: string | null, data: Record<string, unknown>, object: NoticeObject | null) {
  const key = object ? `${object.kind}/${object.namespace ?? ''}/${object.name}` : ''
  useAIContext(
    text ? { source, summary: text, data: { ...data, ...(object ? { object } : {}) } } : null,
    [text, key, JSON.stringify(data)],
  )
}

// A drawer's own read (describe) that failed, said where its fields would be with the server's reason — a refusal
// (403) names what the cluster would not let this identity read. Where the drawer still draws the list's row it says
// so, so a field it could not read is not taken for one the object does not have. The floating chat is told the same.
export function DescribeFailure({ error, showingRow = false, className = '', about }: { error: unknown; showingRow?: boolean; className?: string; about?: NoticeObject }) {
  const { t } = useTranslation()
  const object = useNoticeObject(about)
  const reason = error ? failureText(error) : ''
  const text = !error
    ? null
    : showingRow
      ? t('common.describeFailedRow', { reason, defaultValue: "Could not read the details: {{reason}} Showing what the list's row holds." })
      : t('common.describeFailed', { reason, defaultValue: 'Could not read the details: {{reason}}' })
  useNoticeLayer('DescribeFailure', text, { notice: 'describe_failed', reason, ...(showingRow ? { showing: 'list_row' } : {}) }, object)
  if (!error) return null
  return (
    <p role="alert" data-testid="describe-failed" className={`text-xs text-red-400 break-words ${className}`}>
      {text}
    </p>
  )
}

// A list the drawer reads beside its object (the pods of a namespace, the Ingresses of a class) that failed: the reason
// where the rows would be, never "None" or a count of 0 — on screen and to the floating chat, with the section's name.
export function ListReadFailure({ error, testId = 'list-read-failed', list }: { error: unknown; testId?: string; list?: string }) {
  const { t } = useTranslation()
  const object = useNoticeObject()
  const reason = error ? failureText(error) : ''
  const text = error ? t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason }) : null
  useNoticeLayer('ListReadFailure', text, { notice: 'beside_list_failed', ...(list ? { list } : {}), reason }, object)
  if (!error) return null
  return (
    <p role="alert" data-testid={testId} className="text-xs text-red-400 break-words">
      {text}
    </p>
  )
}

// A drawer that follows its object and whose read again failed: it keeps what it read, and says so with the reason and
// when that was read — as a list's RefreshFailure does — instead of showing the old answer as the object now. The
// floating chat is told the same, so the drawer's layer is not taken for the object now.
export function DescribeStale({ error, readAt }: { error: unknown; readAt: number }) {
  const { t } = useTranslation()
  const object = useNoticeObject()
  const shown = !!error && !!readAt
  const reason = shown ? failureText(error) : ''
  const text = shown
    ? t('common.describeRefreshFailed', {
      reason,
      time: formatTime(readAt),
      defaultValue: 'Could not read the details again: {{reason}} What shows was read at {{time}}.',
    })
    : null
  useNoticeLayer('DescribeStale', text, { notice: 'stale', read_at: shown ? new Date(readAt).toISOString() : null, reason }, object)
  if (!shown) return null
  return (
    <p role="alert" data-testid="describe-stale" className="mb-2 text-xs text-amber-300 break-words">
      {text}
    </p>
  )
}
