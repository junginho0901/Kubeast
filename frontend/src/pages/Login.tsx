import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { clearRedirectAfterLogin, getRedirectAfterLogin, setAccessToken } from '@/services/auth'
import { Activity, Layers, LayoutDashboard, Lock, MessageSquare, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type Mode = 'login' | 'register'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const { data: setupStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.getSetupStatus,
    staleTime: 10000,
  })

  useEffect(() => {
    if (setupStatus && !setupStatus.configured) {
      navigate('/setup', { replace: true })
    }
  }, [setupStatus, navigate])

  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [hq, setHq] = useState('')
  const [team, setTeam] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const redirectTo = useMemo(() => {
    const state = location.state as any
    const from = (state?.from?.pathname as string) || ''
    if (from) return from
    return getRedirectAfterLogin() || '/'
  }, [location.state])

  const loginMutation = useMutation({
    mutationFn: () => api.login({ email, password }),
    onSuccess: (res) => {
      setAccessToken(res.access_token)
      clearRedirectAfterLogin()
      queryClient.setQueryData(['me'], res.member)
      navigate(redirectTo)
    },
  })

  const registerMutation = useMutation({
    mutationFn: () => api.register({ name, email, password, hq, team }),
    onSuccess: async () => {
      await loginMutation.mutateAsync()
    },
  })

  const isBusy = loginMutation.isPending || registerMutation.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isBusy) return
    setFormError(null)

    if (mode === 'register') {
      if (password !== confirmPassword) {
        setFormError(tr('login.errors.passwordMismatch', 'Passwords do not match.'))
        return
      }
      registerMutation.mutate()
      return
    }

    loginMutation.mutate()
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.18),rgba(2,6,23,0))]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(34,211,238,0.12),rgba(2,6,23,0))]" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-[min(92vw,1440px)] items-center px-6 py-12 lg:py-16">
        <div className="grid w-full grid-cols-1 items-center gap-10 lg:gap-14 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs text-slate-300">
              <div className="h-2 w-2 rounded-full bg-primary-500" />
              {tr('login.badge', 'Operate Kubernetes faster')}
            </div>

            <div className="space-y-3">
              <h1 className="text-[clamp(2.25rem,4vw,3.75rem)] font-bold tracking-tight text-white">
                K8s DevOps Assistant
              </h1>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 2xl:p-5">
                <div className="flex items-center gap-2 text-sm 2xl:text-base font-semibold text-white">
                  <LayoutDashboard className="h-4 w-4 text-primary-400" />
                  {tr('login.features.dashboard.title', 'Dashboard')}
                </div>
                <p className="mt-1 text-xs 2xl:text-sm text-slate-400">
                  {tr('login.features.dashboard.subtitle', 'Quickly review cluster overview and key metrics')}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 2xl:p-5">
                <div className="flex items-center gap-2 text-sm 2xl:text-base font-semibold text-white">
                  <Activity className="h-4 w-4 text-cyan-400" />
                  {tr('login.features.monitoring.title', 'Monitoring')}
                </div>
                <p className="mt-1 text-xs 2xl:text-sm text-slate-400">
                  {tr('login.features.monitoring.subtitle', 'Real-time node/pod resource usage')}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 2xl:p-5">
                <div className="flex items-center gap-2 text-sm 2xl:text-base font-semibold text-white">
                  <Layers className="h-4 w-4 text-slate-200" />
                  {tr('login.features.clusterView.title', 'Cluster view')}
                </div>
                <p className="mt-1 text-xs 2xl:text-sm text-slate-400">
                  {tr('login.features.clusterView.subtitle', 'View pod/container logs and manifests')}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 2xl:p-5">
                <div className="flex items-center gap-2 text-sm 2xl:text-base font-semibold text-white">
                  <MessageSquare className="h-4 w-4 text-primary-400" />
                  {tr('login.features.aiChat.title', 'AI Chat')}
                </div>
                <p className="mt-1 text-xs 2xl:text-sm text-slate-400">
                  {tr('login.features.aiChat.subtitle', 'Operations Q&A, root cause analysis, guidance')}
                </p>
              </div>
            </div>

          </div>

          <div className="w-full">
            <div className="mx-auto w-full max-w-[clamp(420px,34vw,560px)] rounded-3xl border border-slate-800 bg-slate-900/40 p-6 lg:p-8 shadow-xl backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {mode === 'login' ? (
                    <Lock className="h-5 w-5 text-primary-400" />
                  ) : (
                    <UserPlus className="h-5 w-5 text-primary-400" />
                  )}
                  <h2 className="text-lg lg:text-xl font-semibold text-white">
                    {mode === 'login'
                      ? tr('login.form.loginTitle', 'Sign in')
                      : tr('login.form.registerTitle', 'Create account')}
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={() => setMode((m) => (m === 'login' ? 'register' : 'login'))}
                  className="text-sm lg:text-base text-slate-300 hover:text-white"
                >
                  {mode === 'login'
                    ? tr('login.form.switchToRegister', 'Create account')
                    : tr('login.form.switchToLogin', 'Sign in')}
                </button>
              </div>

              <p className="mt-2 text-sm lg:text-base text-slate-400">
                {mode === 'login'
                  ? tr('login.form.loginSubtitle', 'Sign in to access the service.')
                  : tr('login.form.registerSubtitle', 'Create a new account and sign in.')}
              </p>

              <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
                {mode === 'register' && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      {tr('login.form.name', 'Name')}
                    </label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                      placeholder={tr('login.form.namePlaceholder', 'Jane Doe')}
                      autoComplete="name"
                    />
                  </div>
                )}

                {mode === 'register' && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        {tr('login.form.hq', 'HQ')}
                      </label>
                      <input
                        value={hq}
                        onChange={(e) => setHq(e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                        placeholder={tr('login.form.hqPlaceholder', 'e.g. Platform')}
                        autoComplete="organization"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        {tr('login.form.team', 'Team')}
                      </label>
                      <input
                        value={team}
                        onChange={(e) => setTeam(e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                        placeholder={tr('login.form.teamPlaceholder', 'e.g. DevOps')}
                        autoComplete="organization"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    {tr('login.form.email', 'Email')}
                  </label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                    placeholder="you@example.com"
                    autoComplete="email"
                    inputMode="email"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    {tr('login.form.password', 'Password')}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      setFormError(null)
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                    placeholder="••••••••"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </div>

                {mode === 'register' && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      {tr('login.form.confirmPassword', 'Confirm password')}
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value)
                        setFormError(null)
                      }}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 lg:py-2.5 text-sm lg:text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                      placeholder="••••••••"
                      autoComplete="new-password"
                    />
                  </div>
                )}

                {(formError || loginMutation.isError || registerMutation.isError) && (
                  <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200" aria-live="polite">
                    {formError ??
                      (mode === 'login'
                        ? tr('login.errors.loginFailed', 'Failed to sign in.')
                        : tr('login.errors.registerFailed', 'Failed to create account.'))}
                  </div>
                )}

              <button
                type="submit"
                disabled={
                  isBusy ||
                  !email.trim() ||
                  !password ||
                  (mode === 'register' && (!confirmPassword || password !== confirmPassword))
                }
                className="w-full rounded-lg bg-primary-600 px-4 py-2.5 lg:py-3 text-sm lg:text-base font-medium text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isBusy
                  ? tr('login.form.processing', 'Processing...')
                  : mode === 'login'
                    ? tr('login.form.submitLogin', 'Sign in')
                    : tr('login.form.submitRegister', 'Create account')}
              </button>
            </form>
          </div>

          </div>
        </div>
      </div>
    </div>
  )
}
