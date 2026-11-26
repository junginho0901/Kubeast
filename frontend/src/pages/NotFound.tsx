import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Compass } from 'lucide-react'

// Any address no route matches, inside the signed-in layout (the sidebar stays,
// so there is a way back). Without it the page was blank.
export default function NotFound() {
  const { t } = useTranslation()
  const location = useLocation()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center px-6" data-testid="not-found">
      <div className="rounded-xl bg-slate-800 border border-hairline p-4 mb-4">
        <Compass className="w-8 h-8 text-slate-500" />
      </div>
      <h1 className="text-[28px] leading-9 font-medium tracking-[-0.02em] text-ink">{t('notFound.title', { defaultValue: 'Page not found' })}</h1>
      <p className="mt-2 max-w-md text-sm text-slate-400 [overflow-wrap:anywhere]">
        {t('notFound.body', { path: location.pathname, defaultValue: 'There is no screen at {{path}}.' })}
      </p>
      <Link to="/" className="btn btn-primary mt-4 text-sm" data-testid="not-found-home">
        {t('notFound.home', { defaultValue: 'Go to the dashboard' })}
      </Link>
    </div>
  )
}
