import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { api } from '@/services/api'

// Where a user who reaches no cluster asks for access — the installation's
// own text and link (chart auth.accessHelp: a ticket form, a channel), shown
// under "no accessible cluster". Renders nothing when neither is set.
export default function AccessHelp({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['access-requests', 'config'],
    queryFn: api.getAccessRequestsConfig,
    staleTime: 60_000,
    retry: false,
  })
  if (!data?.help_text && !data?.help_url) return null
  return (
    <div className={`text-slate-300 ${className}`} data-testid="access-help">
      {data.help_text && <p>{data.help_text}</p>}
      {data.help_url && (
        <a
          href={data.help_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-primary-300 hover:text-primary-200 underline"
          data-testid="access-help-link"
        >
          {t('cluster.noAccess.helpLink', { defaultValue: 'Request access' })}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  )
}
