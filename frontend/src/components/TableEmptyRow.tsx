import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useAIContext, type AIContextInput } from '@/hooks/useAIContext'
import { useForbidden } from '@/services/forbiddenStore'
import { useListStatus } from '@/services/listStatusStore'
import { failureText } from '@/utils/failureText'
import { forbiddenResourceFromUrl, isBuiltinApi } from '@/utils/forbiddenResource'

interface Props {
  colSpan: number
  /** API path segment of the list ("pods", "vpas", "rolebindings") — the one the request was for */
  resource: string
  /** A search box has text: the row says no row matched instead of the list being empty */
  searching?: boolean
  /** Replaces the shared empty text (tables that are not a plain list) */
  children?: ReactNode
  className?: string
  /** The list's own read failed — a read outside /cluster/, which the list status does not follow: its reason, with a retry */
  error?: unknown
  onRetry?: () => void
}

// The empty row of a list table. "No items" would read as "the cluster has
// none", so the row says what really happened when it knows: the kind is not
// installed on the cluster (its CRD is missing — or, for a built-in API such
// as DRA or the admission policies, the cluster does not serve it), the list
// failed on the server (with a retry), or the request answered 403. Otherwise
// one shared text: no items, or no search results while the search box has text.
// A failed list and a kind the cluster does not have are told to the floating
// chat in the row's words (a refusal is the ForbiddenBanner's to tell), so the
// chat does not read the empty table as a list with nothing in it.
export function TableEmptyRow({ colSpan, resource, searching = false, children, className = 'py-6 px-4 text-center text-slate-400', error, onRetry }: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const forbidden = useForbidden(resource)
  const status = useListStatus(resource)
  const kind = forbiddenResourceFromUrl(`/cluster/${resource}`)

  let body: ReactNode =
    children ?? (searching ? t('common.noSearchResults', 'No results found.') : t('common.listEmpty', 'No items.'))
  let testId: string | undefined
  const retry = (
    <button
      type="button"
      onClick={() => (onRetry ? onRetry() : void queryClient.refetchQueries({ type: 'active' }))}
      className="ml-3 rounded-sm border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:border-slate-400"
      data-testid="table-load-error-retry"
    >
      {t('common.retry', { defaultValue: 'Retry' })}
    </button>
  )
  let told: AIContextInput | null = null
  if (error) {
    testId = 'table-load-error'
    const reason = failureText(error)
    const text = t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason })
    told = { source: 'TableEmptyRow', summary: text, data: { notice: 'list_failed', list: kind, reason } }
    body = (
      <>
        {text}
        {retry}
      </>
    )
  } else if (status?.state === 'notInstalled') {
    testId = 'table-not-installed'
    const builtin = isBuiltinApi(resource)
    const text = builtin
      ? t('common.notServedEmpty', {
        resource: kind,
        defaultValue: '{{resource}} is not served by this cluster (a built-in Kubernetes API that its version does not have or that is turned off).',
      })
      : t('common.notInstalledEmpty', {
        resource: kind,
        defaultValue: '{{resource}} is not installed on this cluster (no CustomResourceDefinition).',
      })
    told = { source: 'TableEmptyRow', summary: text, data: { notice: builtin ? 'not_served' : 'not_installed', list: kind } }
    body = text
  } else if (status?.state === 'error') {
    testId = 'table-load-error'
    const text = status.code && status.reason
      ? t('common.loadErrorEmptyReason', { resource: kind, code: status.code, reason: status.reason, defaultValue: 'Could not load {{resource}} (server error {{code}}): {{reason}}' })
      : status.code
      ? t('common.loadErrorEmpty', { resource: kind, code: status.code, defaultValue: 'Could not load {{resource}} (server error {{code}}).' })
      : t('common.loadErrorEmptyNetwork', { resource: kind, defaultValue: 'Could not load {{resource}} (no response from the server).' })
    told = { source: 'TableEmptyRow', summary: text, data: { notice: 'list_failed', list: kind, code: status.code ?? null, ...(status.reason ? { reason: status.reason } : {}) } }
    body = (
      <>
        {text}
        {retry}
      </>
    )
  } else if (forbidden) {
    testId = 'table-forbidden'
    body = t('common.forbiddenEmpty', {
      resource: kind,
      defaultValue: 'You do not have permission to view {{resource}} in this cluster.',
    })
  }
  useAIContext(told, [told?.summary, told?.data?.notice, kind])
  return (
    <tr>
      <td colSpan={colSpan} className={className} data-testid={testId}>
        {body}
      </td>
    </tr>
  )
}
