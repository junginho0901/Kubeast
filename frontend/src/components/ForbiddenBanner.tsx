import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { resetForbidden, useForbiddenLabels } from '@/services/forbiddenStore'
import { resetListStatus } from '@/services/listStatusStore'
import { joinResources } from '@/utils/forbiddenResource'
import { usePermission } from '@/hooks/usePermission'
import { customRoleGroup } from '@/utils/roleGroup'

// Shown above the page when a cluster list request answered 403 for the
// signed-in user. The forbidden store collects those responses (the API
// client dispatches FORBIDDEN_EVENT for each); the list tables read the same
// store for their empty row. The set resets on every route or cluster change
// (the page remounts under Layout's key).
export default function ForbiddenBanner({ clusterKey }: { clusterKey: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const resources = useForbiddenLabels()
  const { clusterRole, permissions } = usePermission()
  // A custom role acts on the cluster as its own group; until the cluster
  // allows and binds it, every request is refused — say which group that is.
  const isGlobalAdmin = (permissions['*'] ?? []).includes('*')
  const group = isGlobalAdmin ? null : customRoleGroup(clusterRole)

  useEffect(() => {
    resetForbidden()
    resetListStatus()
  }, [location.pathname, clusterKey])

  if (resources.length === 0) return null
  return (
    <div
      role="status"
      data-testid="forbidden-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-100"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div>
        <div className="font-medium text-amber-200">{t('layout.forbidden.title', { defaultValue: 'No permission' })}</div>
        <div className="mt-0.5 text-amber-100/90">
          {t('layout.forbidden.body', {
            defaultValue: 'You do not have permission to view {{resources}} in this cluster. Ask an administrator for a role that includes it.',
            resources: joinResources(resources),
          })}
        </div>
        {group && (
          <div data-testid="forbidden-custom-role-hint" className="mt-1 text-amber-100/80">
            {t('layout.forbidden.customRole', {
              defaultValue:
                'Your role "{{role}}" acts on this cluster as the Kubernetes group {{group}}. If every page shows this notice, the cluster has not allowed and bound that group yet (chart auth.impersonation.customRoles).',
              role: clusterRole,
              group,
            })}
          </div>
        )}
      </div>
    </div>
  )
}
