import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { resetForbidden, useForbiddenLabels } from '@/services/forbiddenStore'
import { resetListStatus } from '@/services/listStatusStore'
import { joinResources } from '@/utils/forbiddenResource'
import { usePermission } from '@/hooks/usePermission'
import { useAIContext } from '@/hooks/useAIContext'
import { LISTS_AND_DETAILS } from '@/utils/permissions'
import { customRoleGroup, takesBuiltinSlug } from '@/utils/roleGroup'

// Shown above the page when a cluster list request answered 403 for the
// signed-in user. The forbidden store collects those responses (the API
// client dispatches FORBIDDEN_EVENT for each); the list tables read the same
// store for their empty row. The set resets on every route or cluster change
// (the page remounts under Layout's key). It tells the floating chat the same
// words and the kinds refused, so a page whose list was refused is not read as
// one with nothing in it.
export default function ForbiddenBanner({ clusterKey }: { clusterKey: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const resources = useForbiddenLabels()
  const { has, clusterRole, permissions, clusterNamespaces } = usePermission()
  const readsLists = has(LISTS_AND_DETAILS)
  // A custom role acts on the cluster as its own group; until the cluster
  // allows and binds it, every request is refused — say which group that is.
  // A role without the read permission never gets that far: the cluster is not why.
  const isGlobalAdmin = (permissions['*'] ?? []).includes('*')
  const group = isGlobalAdmin || !readsLists ? null : customRoleGroup(clusterRole)
  // A custom role named as a built-in in other capitals ("ADMIN", stored before such names were refused) acts as no
  // role group (auth.TakesBuiltinSlug): the cluster refuses what it reads, whatever it binds.
  const builtinName = !isGlobalAdmin && readsLists && takesBuiltinSlug(clusterRole)

  useEffect(() => {
    resetForbidden()
    resetListStatus()
  }, [location.pathname, clusterKey])

  const shown = resources.length > 0
  const title = t('layout.forbidden.title', { defaultValue: 'No permission' })
  const body = t('layout.forbidden.body', {
    defaultValue: 'You do not have permission to view {{resources}} in this cluster. Ask an administrator for a role that includes it.',
    resources: joinResources(resources),
  })
  const namespacesHint = clusterNamespaces && clusterNamespaces.length > 0
    ? t('layout.forbidden.namespaces', {
      defaultValue: 'Your access to this cluster is limited to the namespaces {{namespaces}}; cluster-wide pages and other namespaces are not shown.',
      namespaces: clusterNamespaces.join(', '),
    })
    : null
  const readPermissionHint = !readsLists
    ? t('layout.forbidden.readPermission', {
      defaultValue:
        'Your role on this cluster holds neither resource.objects.read (lists and details) nor resource.*.read (All resources: read), so Kubeast reads no list for it. Ask an administrator to add one.',
    })
    : null
  const builtinNameHint = builtinName
    ? t('layout.forbidden.builtinName', {
      defaultValue:
        'Your role "{{role}}" has a built-in role\'s name in other capitals or with spaces, so on this cluster it acts as no role group and the cluster refuses what it reads. Ask an administrator for a built-in role here, or to rename this one.',
      role: clusterRole,
    })
    : null
  const customRoleHint = group
    ? t('layout.forbidden.customRole', {
      defaultValue:
        'Your role "{{role}}" acts on this cluster as the Kubernetes group {{group}}. If every page shows this notice, the cluster has not allowed and bound that group yet (chart auth.impersonation.customRoles).',
      role: clusterRole,
      group,
    })
    : null
  const said = [`${title}: ${body}`, namespacesHint, readPermissionHint, builtinNameHint, customRoleHint].filter(Boolean).join(' ')
  const refusedKey = resources.join('\n')
  const namespacesKey = clusterNamespaces?.join('\n') ?? ''
  useAIContext(shown ? {
    source: 'ForbiddenBanner',
    summary: said,
    data: {
      notice: 'forbidden',
      refused: resources,
      ...(namespacesHint ? { access_limited_to_namespaces: clusterNamespaces } : {}),
      ...(readPermissionHint ? { role_reads_no_list: true } : {}),
      ...(builtinNameHint ? { role_named_as_builtin: true } : {}),
      ...(group ? { custom_role_group: group } : {}),
    },
  } : null, [said, refusedKey, namespacesKey])

  if (!shown) return null
  return (
    <div
      role="status"
      data-testid="forbidden-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-200"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="font-medium text-amber-200">{title}</div>
        <div className="mt-0.5 text-amber-200/90">{body}</div>
        {namespacesHint && (
          <div data-testid="forbidden-namespace-hint" className="mt-1 text-amber-200/80">{namespacesHint}</div>
        )}
        {readPermissionHint && (
          <div data-testid="forbidden-read-permission-hint" className="mt-1 text-amber-200/80">{readPermissionHint}</div>
        )}
        {builtinNameHint && (
          <div data-testid="forbidden-builtin-name-hint" className="mt-1 text-amber-200/80">{builtinNameHint}</div>
        )}
        {customRoleHint && (
          <div data-testid="forbidden-custom-role-hint" className="mt-1 text-amber-200/80">{customRoleHint}</div>
        )}
      </div>
    </div>
  )
}
