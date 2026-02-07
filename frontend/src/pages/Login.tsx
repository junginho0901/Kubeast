import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { setAccessToken } from '@/services/auth'
import { Lock, UserPlus } from 'lucide-react'

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
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode === 'login' ? (
              <Lock className="h-5 w-5 text-primary-400" />
            ) : (
              <UserPlus className="h-5 w-5 text-primary-400" />
            )}
            <h1 className="text-lg font-semibold text-white">{mode === 'login' ? '로그인' : '회원가입'}</h1>
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

        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-300">
          기본 관리자: <span className="text-white">admin@local</span> / <span className="text-white">admin</span>
        </div>

        <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">이름</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
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
              className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
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
              className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
              placeholder="••••••••"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {(loginMutation.isError || registerMutation.isError) && (
            <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
              {mode === 'login' ? '로그인에 실패했습니다.' : '회원가입에 실패했습니다.'}
            </div>
          )}

          <button
            type="submit"
            disabled={isBusy || !email.trim() || !password}
            className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isBusy ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>
      </div>
    </div>
  )
}

