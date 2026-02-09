import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/services/api'
import { KeyRound, User } from 'lucide-react'

export default function Account() {
  const queryClient = useQueryClient()
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 30000, retry: false })

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const changePasswordMutation = useMutation({
    mutationFn: () => api.changePassword({ current_password: currentPassword, new_password: newPassword }),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setLocalError(null)
      setSuccess('비밀번호가 변경되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: () => {
      setSuccess(null)
    },
  })

  const isBusy = changePasswordMutation.isPending

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSuccess(null)
    if (!currentPassword || !newPassword) {
      setLocalError('현재 비밀번호와 새 비밀번호를 입력하세요.')
      return
    }
    if (newPassword !== confirmPassword) {
      setLocalError('새 비밀번호가 일치하지 않습니다.')
      return
    }
    setLocalError(null)
    changePasswordMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">계정</h1>
        <p className="mt-2 text-slate-400">비밀번호를 변경할 수 있습니다.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary-500/10">
              <User className="w-6 h-6 text-primary-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">내 정보</h2>
              <p className="text-sm text-slate-400">로그인된 계정 정보</p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
            <div className="text-xs text-slate-400">이름</div>
            <div className="mt-1 text-sm text-white">{me?.name ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">이메일</div>
            <div className="mt-1 text-sm text-white">{me?.email ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">본부</div>
            <div className="mt-1 text-sm text-white">{me?.hq ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">팀</div>
            <div className="mt-1 text-sm text-white">{me?.team ?? '-'}</div>
            <div className="mt-3 text-xs text-slate-400">Role</div>
            <div className="mt-1 text-sm text-white">{me?.role ?? '-'}</div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-cyan-500/10">
              <KeyRound className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">비밀번호 변경</h2>
              <p className="text-sm text-slate-400">현재 비밀번호를 확인합니다</p>
            </div>
          </div>

          {success && (
            <div className="mb-3 rounded-lg border border-green-900/40 bg-green-950/30 px-3 py-2 text-sm text-green-200">
              {success}
            </div>
          )}

          {(localError || changePasswordMutation.isError) && (
            <div className="mb-3 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
              {localError ?? '비밀번호 변경에 실패했습니다.'}
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">현재 비밀번호</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">새 비밀번호</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                placeholder="최소 4자"
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">새 비밀번호 확인</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                placeholder="다시 입력"
                autoComplete="new-password"
              />
            </div>

            <button
              type="submit"
              disabled={isBusy}
              className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isBusy ? '변경 중...' : '비밀번호 변경'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
