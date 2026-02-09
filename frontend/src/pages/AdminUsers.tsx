import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member } from '@/services/api'
import { CheckCircle, ChevronDown, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAccessToken } from '@/services/auth'

export default function AdminUsers() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [limit] = useState(100)
  const [offset] = useState(0)
  const [roleDrafts, setRoleDrafts] = useState<Record<string, 'admin' | 'user'>>({})
  const [openRoleDropdownUserId, setOpenRoleDropdownUserId] = useState<string | null>(null)
  const roleDropdownRef = useRef<HTMLDivElement | null>(null)

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
    retry: false,
  })

  const { data: users, isLoading, isError } = useQuery({
    queryKey: ['admin-users', limit, offset],
    queryFn: () => api.adminListUsers({ limit, offset }),
    staleTime: 5000,
    retry: false,
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'user' }) => api.adminUpdateUserRole(userId, role),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })

      // 본인 권한을 admin -> user 로 내린 경우: 즉시 로그아웃시키고 재로그인 유도
      if (me?.id && vars.userId === me.id && vars.role !== 'admin') {
        clearAccessToken()
        queryClient.clear()
        navigate('/login', { replace: true })
      }
    },
    onError: (_err, vars) => {
      // 실패 시 서버 값으로 되돌리기(다음 refetch에 맞춤)
      setRoleDrafts((prev) => {
        const next = { ...prev }
        delete next[vars.userId]
        return next
      })
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.adminResetUserPassword(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.adminDeleteUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
  })

  useEffect(() => {
    roleDropdownRef.current = null
  }, [openRoleDropdownUserId])

  useEffect(() => {
    if (!openRoleDropdownUserId) return

    const handleClickOutside = (event: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(event.target as Node)) {
        setOpenRoleDropdownUserId(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [openRoleDropdownUserId])

  if (isLoading) {
    return <div className="text-slate-300">로딩 중...</div>
  }

  if (isError) {
    return <div className="text-slate-300">유저 목록을 불러오지 못했습니다.</div>
  }

  const rows: Member[] = Array.isArray(users) ? users : []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">유저 관리</h1>
        <p className="mt-2 text-slate-400">유저 권한(user/admin)을 변경합니다.</p>
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800">
            <tr className="text-left text-slate-300">
              <th className="px-4 py-3">이름</th>
              <th className="px-4 py-3">이메일</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">비밀번호</th>
              <th className="px-4 py-3">삭제</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const isUpdating = updateRoleMutation.isPending && updateRoleMutation.variables?.userId === u.id
              const isResetting = resetPasswordMutation.isPending && resetPasswordMutation.variables?.userId === u.id
              const isDeleting = deleteUserMutation.isPending && deleteUserMutation.variables?.userId === u.id
              const currentRole = (roleDrafts[u.id] ?? (u.role === 'admin' ? 'admin' : 'user')) as 'admin' | 'user'
              const isOpen = openRoleDropdownUserId === u.id
              const isSelf = !!me?.id && me.id === u.id
              return (
                <tr key={u.id} className="border-t border-slate-700 text-slate-200">
                  <td className="px-4 py-3">{u.name}</td>
                  <td className="px-4 py-3">{u.email ?? '-'}</td>
                  <td className="px-4 py-3">
                    <div
                      className="relative inline-block"
                      ref={(el) => {
                        if (isOpen) roleDropdownRef.current = el
                      }}
                    >
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() => setOpenRoleDropdownUserId((prev) => (prev === u.id ? null : u.id))}
                        className="w-32 inline-flex items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-none focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                        aria-haspopup="menu"
                        aria-expanded={isOpen}
                      >
                        <span className="truncate">{currentRole === 'admin' ? 'ADMIN' : 'USER'}</span>
                        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {isOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 mt-2 w-32 rounded-xl border border-slate-700 bg-slate-900 shadow-xl z-50 overflow-hidden"
                        >
                          {(['user', 'admin'] as const).map((role) => {
                            const isSelected = currentRole === role
                            return (
                              <button
                                key={role}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenRoleDropdownUserId(null)
                                  if (role === currentRole) return
                                  setRoleDrafts((prev) => ({ ...prev, [u.id]: role }))
                                  updateRoleMutation.mutate({ userId: u.id, role })
                                }}
                                className={`w-full px-3 py-2 text-xs flex items-center gap-2 hover:bg-slate-800 transition-colors ${
                                  isSelected ? 'bg-slate-800 text-white' : 'text-slate-200'
                                }`}
                              >
                                <span className="flex-1 text-left">{role === 'admin' ? 'ADMIN' : 'USER'}</span>
                                {isSelected && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={isResetting}
                      onClick={() => {
                        const ok = window.confirm(`비밀번호를 1111로 초기화할까요?\n\n대상: ${u.email ?? u.name}`)
                        if (!ok) return
                        resetPasswordMutation.mutate({ userId: u.id })
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/40 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-none focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                      title="비밀번호를 1111로 초기화"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                      <span>{isResetting ? '초기화중' : 'PW 초기화'}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={isDeleting || isSelf}
                      onClick={() => {
                        const ok = window.confirm(`유저를 삭제할까요?\n\n대상: ${u.email ?? u.name}\n\n* 삭제하면 복구가 어렵습니다.`)
                        if (!ok) return
                        deleteUserMutation.mutate({ userId: u.id })
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/60 bg-red-950/20 px-2.5 py-2 text-xs text-red-200 hover:bg-red-950/35 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:opacity-50"
                      title={isSelf ? '자기 자신은 삭제할 수 없습니다.' : '유저 삭제'}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-300" />
                      <span>{isDeleting ? '삭제중' : '삭제'}</span>
                    </button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-300" colSpan={5}>
                  유저가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
