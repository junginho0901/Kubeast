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
      <div className="rounded-full bg-slate-800 border border-slate-700 p-4 mb-4">
        <Compass className="w-8 h-8 text-slate-500" />
      </div>
      <h1 className="text-lg font-semibold text-white">{t('notFound.title', { defaultValue: 'Page not found' })}</h1>
      <p className="mt-1 max-w-md text-sm text-slate-400">
        {t('notFound.body', { path: location.pathname, defaultValue: 'There is no screen at {{path}}.' })}
      </p>
      <Link to="/" className="mt-4 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-500" data-testid="not-found-home">
        {t('notFound.home', { defaultValue: 'Go to the dashboard' })}
      </Link>
    </div>
  )
}
