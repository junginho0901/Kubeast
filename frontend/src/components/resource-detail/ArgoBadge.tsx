import { GitBranch } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ArgoManaged } from './gitops'

// ArgoBadge names the Argo CD Application that manages the object and links
// to it when the chart knows the Argo CD UI (gitops.argocd.url).
export function ArgoBadge({ argo, url, blocked }: { argo: ArgoManaged | null; url: string | null; blocked: boolean }) {
  const { t } = useTranslation()
  if (!argo) return null
  const label = t('common.gitops.managedBy', { app: argo.app, defaultValue: 'Argo CD · {{app}}' })
  const hint = blocked
    ? t('common.gitops.blocked', { defaultValue: 'Managed by Argo CD — change it in Git. Writes from the console are refused.' })
    : t('common.gitops.warn', { defaultValue: 'Managed by Argo CD — a change made here is reverted on the next sync. Change it in Git.' })
  const cls = 'mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200'
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className={cls} title={hint} data-testid="argo-badge">
      <GitBranch className="w-3 h-3" />
      <span className="font-medium">{label}</span>
    </a>
  ) : (
    <span className={cls} title={hint} data-testid="argo-badge">
      <GitBranch className="w-3 h-3" />
      <span className="font-medium">{label}</span>
    </span>
  )
}
