import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
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
  if (error) {
    testId = 'table-load-error'
    body = (
      <>
        {t('common.readFailed', { defaultValue: 'Could not read the list: {{reason}}', reason: failureText(error) })}
        {retry}
      </>
    )
  } else if (status?.state === 'notInstalled') {
    testId = 'table-not-installed'
    body = isBuiltinApi(resource)
      ? t('common.notServedEmpty', {
        resource: kind,
        defaultValue: '{{resource}} is not served by this cluster (a built-in Kubernetes API that its version does not have or that is turned off).',
      })
      : t('common.notInstalledEmpty', {
        resource: kind,
        defaultValue: '{{resource}} is not installed on this cluster (no CustomResourceDefinition).',
      })
  } else if (status?.state === 'error') {
    testId = 'table-load-error'
    body = (
      <>
        {status.code && status.reason
          ? t('common.loadErrorEmptyReason', { resource: kind, code: status.code, reason: status.reason, defaultValue: 'Could not load {{resource}} (server error {{code}}): {{reason}}' })
          : status.code
          ? t('common.loadErrorEmpty', { resource: kind, code: status.code, defaultValue: 'Could not load {{resource}} (server error {{code}}).' })
          : t('common.loadErrorEmptyNetwork', { resource: kind, defaultValue: 'Could not load {{resource}} (no response from the server).' })}
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
  return (
    <tr>
      <td colSpan={colSpan} className={className} data-testid={testId}>
        {body}
      </td>
    </tr>
  )
}
