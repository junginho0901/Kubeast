import { Clock, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { clearAccessToken } from '@/services/auth'
import { useTranslation } from 'react-i18next'

export default function PendingApproval() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const handleLogout = () => {
    clearAccessToken()
    queryClient.clear()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.18),rgba(2,6,23,0))]" />
      </div>

      <div className="relative w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/40 p-8 shadow-xl backdrop-blur text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/20">
          <Clock className="h-8 w-8 text-amber-400" />
        </div>

        <h1 className="mt-6 text-2xl font-bold text-white">
          {tr('pending.title', 'Waiting for approval')}
        </h1>

        <p className="mt-3 text-sm text-slate-400 leading-relaxed">
          {tr('pending.description', 'Your account has been created. An administrator needs to approve your account before you can access the service.')}
        </p>

        <div className="mt-6 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
          <p className="text-xs text-slate-500">
            {tr('pending.hint', 'Please contact your administrator to get your account approved.')}
          </p>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="mt-6 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" />
          {tr('pending.logout', 'Sign out')}
        </button>
      </div>
    </div>
  )
}
