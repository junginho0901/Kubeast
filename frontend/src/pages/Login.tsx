import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { setAccessToken } from '@/services/auth'
import { Activity, Layers, LayoutDashboard, Lock, MessageSquare, UserPlus } from 'lucide-react'

type Mode = 'login' | 'register'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const redirectTo = useMemo(() => {
    const state = location.state as any
    return (state?.from?.pathname as string) || '/'
  }, [location.state])

  const loginMutation = useMutation({
    mutationFn: () => api.login({ email, password }),
    onSuccess: (res) => {
      setAccessToken(res.access_token)
      queryClient.setQueryData(['me'], res.member)
      navigate(redirectTo)
    },
  })

  const registerMutation = useMutation({
    mutationFn: () => api.register({ name, email, password }),
    onSuccess: async () => {
      await loginMutation.mutateAsync()
    },
  })

  const isBusy = loginMutation.isPending || registerMutation.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isBusy) return
    if (mode === 'login') loginMutation.mutate()
    else registerMutation.mutate()
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.18),rgba(2,6,23,0))]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(34,211,238,0.12),rgba(2,6,23,0))]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl items-center px-6 py-12">
        <div className="grid w-full grid-cols-1 items-center gap-10 lg:grid-cols-2">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs text-slate-300">
              <div className="h-2 w-2 rounded-full bg-primary-500" />
              Kubernetes 운영을 더 빠르게
            </div>

            <div className="space-y-3">
              <h1 className="text-4xl font-bold tracking-tight text-white">
                K8s DevOps Assistant
              </h1>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <LayoutDashboard className="h-4 w-4 text-primary-400" />
                  대시보드
                </div>
                <p className="mt-1 text-xs text-slate-400">클러스터 개요/핵심 지표를 빠르게 확인</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Activity className="h-4 w-4 text-cyan-400" />
                  모니터링
                </div>
                <p className="mt-1 text-xs text-slate-400">Node/Pod 리소스 사용량 실시간 조회</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Layers className="h-4 w-4 text-slate-200" />
                  클러스터 뷰
                </div>
                <p className="mt-1 text-xs text-slate-400">Pod/컨테이너 로그/매니페스트 확인</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <MessageSquare className="h-4 w-4 text-primary-400" />
                  AI 챗
                </div>
                <p className="mt-1 text-xs text-slate-400">운영 질문/원인 분석/가이드 추천</p>
              </div>
            </div>

          </div>

          <div className="w-full">
            <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/40 p-6 shadow-xl backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {mode === 'login' ? (
                    <Lock className="h-5 w-5 text-primary-400" />
                  ) : (
                    <UserPlus className="h-5 w-5 text-primary-400" />
                  )}
                  <h2 className="text-lg font-semibold text-white">{mode === 'login' ? '로그인' : '회원가입'}</h2>
                </div>

                <button
                  type="button"
                  onClick={() => setMode((m) => (m === 'login' ? 'register' : 'login'))}
                  className="text-sm text-slate-300 hover:text-white"
                >
                  {mode === 'login' ? '회원가입' : '로그인'}
                </button>
              </div>

              <p className="mt-2 text-sm text-slate-400">
                {mode === 'login'
                  ? '계정으로 로그인하여 서비스를 이용하세요.'
                  : '새 계정을 만들고 바로 로그인합니다.'}
              </p>

              <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
                {mode === 'register' && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">이름</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                      placeholder="홍길동"
                      autoComplete="name"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs text-slate-400 mb-1">이메일</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                    placeholder="you@example.com"
                    autoComplete="email"
                    inputMode="email"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">비밀번호</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                    placeholder="••••••••"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </div>

                {(loginMutation.isError || registerMutation.isError) && (
                  <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200" aria-live="polite">
                    {mode === 'login' ? '로그인에 실패했습니다.' : '회원가입에 실패했습니다.'}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isBusy || !email.trim() || !password}
                  className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
                </button>
              </form>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
