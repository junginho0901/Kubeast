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
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-700 bg-slate-800/40 p-10 shadow-sm">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{t('comingSoon.badge', 'Coming Soon')}</div>
        <h1 className="mt-3 text-3xl font-semibold text-white">{title}</h1>
        <p className="mt-4 text-slate-300">
          {description || t('comingSoon.description', 'This section is being prepared. The sidebar structure is ready and features will be filled in next.')}
        </p>
        <div className="mt-6 text-sm text-slate-500">
          {t('comingSoon.route', 'Route:')} <span className="font-mono text-slate-300">{location.pathname}</span>
        </div>
      </div>
    </div>
  )
}
