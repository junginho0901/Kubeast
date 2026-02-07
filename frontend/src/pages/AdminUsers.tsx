import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member } from '@/services/api'
import { useState } from 'react'

export default function AdminUsers() {
  const queryClient = useQueryClient()
  const [limit] = useState(100)
  const [offset] = useState(0)

  const { data: users, isLoading, isError } = useQuery({
    queryKey: ['admin-users', limit, offset],
    queryFn: () => api.adminListUsers({ limit, offset }),
    staleTime: 5000,
    retry: false,
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'user' }) => api.adminUpdateUserRole(userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

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
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const isUpdating = updateRoleMutation.isPending && updateRoleMutation.variables?.userId === u.id
              return (
                <tr key={u.id} className="border-t border-slate-700 text-slate-200">
                  <td className="px-4 py-3">{u.name}</td>
                  <td className="px-4 py-3">{u.email ?? '-'}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-md border border-slate-600 bg-slate-900/40 px-2 py-1 text-xs">
                      {String(u.role).toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() => updateRoleMutation.mutate({ userId: u.id, role: 'user' })}
                        className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700/40 disabled:opacity-50"
                      >
                        USER
                      </button>
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() => updateRoleMutation.mutate({ userId: u.id, role: 'admin' })}
                        className="rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700/40 disabled:opacity-50"
                      >
                        ADMIN
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-300" colSpan={4}>
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

