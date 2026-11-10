import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

type ComingSoonProps = {
  title: string
  description?: string
}

export default function ComingSoon({ title, description }: ComingSoonProps) {
  const location = useLocation()
  const { t } = useTranslation()

  return (
    <div className="min-h-[calc(100vh-4rem)]">
      <div className="card mx-auto max-w-3xl">
        <div className="text-xs text-slate-400">{t('comingSoon.badge', 'Coming Soon')}</div>
        <h1 className="mt-3 text-[28px] leading-9 font-medium text-ink [overflow-wrap:anywhere]">{title}</h1>
        <p className="mt-4 text-slate-300">
          {description || t('comingSoon.description', 'This section is being prepared. The sidebar structure is ready and features will be filled in next.')}
        </p>
        <div className="mt-6 text-sm text-slate-400 [overflow-wrap:anywhere]">
          {t('comingSoon.route', 'Route:')} <span className="font-mono text-slate-300">{location.pathname}</span>
        </div>
      </div>
    </div>
  )
}
