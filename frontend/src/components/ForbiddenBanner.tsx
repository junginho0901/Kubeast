import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { FORBIDDEN_EVENT } from '@/services/api/client'
import { forbiddenResourceFromUrl, joinResources } from '@/utils/forbiddenResource'

// Shown above the page when a cluster list request answered 403 for the
// signed-in user: every list page renders "No … found." on an empty result,
// which is misleading when the real reason is a missing cluster role. The API
// client dispatches FORBIDDEN_EVENT for each such response; the set resets on
// every route or cluster change (the page remounts under Layout's key).
export default function ForbiddenBanner({ clusterKey }: { clusterKey: string }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [resources, setResources] = useState<string[]>([])

  useEffect(() => {
    setResources([])
  }, [location.pathname, clusterKey])

  useEffect(() => {
    const onForbidden = (e: Event) => {
      const url = String((e as CustomEvent<{ url?: string }>).detail?.url || '')
      const name = forbiddenResourceFromUrl(url)
      setResources((prev) => (prev.includes(name) ? prev : [...prev, name]))
    }
    window.addEventListener(FORBIDDEN_EVENT, onForbidden)
    return () => window.removeEventListener(FORBIDDEN_EVENT, onForbidden)
  }, [])

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
            defaultValue: 'You do not have permission to view {{resources}} in this cluster. The list below only shows what you can read; ask an administrator for a role that includes it.',
            resources: joinResources(resources),
          })}
        </div>
      </div>
    </div>
  )
}
