import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member, RoleWithDetails } from '@/services/api'
import { CheckCircle, ChevronDown, ChevronUp, Clock, Download, Pencil, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearAccessToken } from '@/services/auth'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useTranslation } from 'react-i18next'
import { usePermission } from '@/hooks/usePermission'

export default function AdminUsers() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const [limit] = useState(100)
  const [offset] = useState(0)
  const [roleDrafts, setRoleDrafts] = useState<Record<string, number>>({})
  const [openRoleDropdownUserId, setOpenRoleDropdownUserId] = useState<string | null>(null)
  const roleDropdownRef = useRef<HTMLDivElement | null>(null)
  const [reauthModalOpen, setReauthModalOpen] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role_id: 0, hq: '', team: '' })

  // Pending modal
  const [pendingModalOpen, setPendingModalOpen] = useState(false)
  const [pendingSelectedIds, setPendingSelectedIds] = useState<Set<string>>(new Set())

  // Bulk upload
  const [bulkUploadModalOpen, setBulkUploadModalOpen] = useState(false)
  const [bulkUploadResult, setBulkUploadResult] = useState<{ created: Member[]; errors: Array<{ email: string; message: string }> } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Sorting
  type SortKey = 'name' | 'email' | 'hq' | 'team' | 'role' | null
  type SortDir = 'asc' | 'desc'
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // User detail modal
  const [detailUserId, setDetailUserId] = useState<string | null>(null)
  const [detailEditing, setDetailEditing] = useState(false)
  const [detailDraft, setDetailDraft] = useState<{ name: string; hq: string; team: string; role_id: number }>({
    name: '', hq: '', team: '', role_id: 0,
  })
  const [detailError, setDetailError] = useState<string | null>(null)
  const { has: hasPerm } = usePermission()
  const canEditUsers = hasPerm('admin.users.update')

  const { data: hqOptions = [] } = useQuery({
    queryKey: ['organizations', 'hq'],
    queryFn: () => api.listOrganizations('hq'),
    staleTime: 60000,
  })
  const { data: teamOptions = [] } = useQuery({
    queryKey: ['organizations', 'team'],
    queryFn: () => api.listOrganizations('team'),
    staleTime: 60000,
  })

  const { data: roles = [] } = useQuery<RoleWithDetails[]>({
    queryKey: ['roles'],
    queryFn: api.listRoles,
    staleTime: 60000,
  })

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 30000,
    retry: false,
    enabled: !reauthModalOpen,
  })

  const { data: users, isLoading, isError } = useQuery({
    queryKey: ['admin-users', limit, offset],
    queryFn: () => api.adminListUsers({ limit, offset }),
    staleTime: 5000,
    retry: false,
    enabled: !reauthModalOpen,
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: number }) => api.adminUpdateUserRole(userId, roleId),
    onSuccess: (_data, vars) => {
      const roleName = roles.find((r) => r.id === vars.roleId)?.name
      if (me?.id && vars.userId === me.id && roleName !== 'admin') {
        setReauthModalOpen(true)
        return
      }
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (_err, vars) => {
      setRoleDrafts((prev) => {
        const next = { ...prev }
        delete next[vars.userId]
        return next
      })
    },
  })

  const bulkUpdateRoleMutation = useMutation({
    mutationFn: ({ userIds, roleId }: { userIds: string[]; roleId: number }) => api.adminBulkUpdateRole(userIds, roleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setPendingSelectedIds(new Set())
      setPendingModalOpen(false)
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

  const createUserMutation = useMutation({
    mutationFn: () => api.adminCreateUser({
      name: newUser.name,
      email: newUser.email,
      password: newUser.password,
      role_id: newUser.role_id,
      hq: newUser.hq || undefined,
      team: newUser.team || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreateModalOpen(false)
      setNewUser({ name: '', email: '', password: '', role_id: 0, hq: '', team: '' })
    },
  })

  const bulkCreateMutation = useMutation({
    mutationFn: (csvUsers: Array<{ name: string; email: string; password: string; role_id: number; hq?: string; team?: string }>) =>
      api.adminBulkCreateUsers(csvUsers),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setBulkUploadResult(result)
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: { name?: string; hq?: string; team?: string; role_id?: number } }) =>
      api.adminUpdateUser(userId, payload),
    onSuccess: (_data, vars) => {
      const newRoleName = vars.payload.role_id != null
        ? roles.find((r) => r.id === vars.payload.role_id)?.name
        : undefined
      if (me?.id && vars.userId === me.id && newRoleName && newRoleName !== 'admin') {
        setReauthModalOpen(true)
        setDetailUserId(null)
        setDetailEditing(false)
        return
      }
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
      setDetailEditing(false)
      setDetailError(null)
    },
    onError: (err: any) => {
      setDetailError(err?.response?.data?.error || err?.message || 'Failed to update user')
    },
  })

  const openDetail = (u: Member) => {
    setDetailUserId(u.id)
    setDetailEditing(false)
    setDetailError(null)
    setDetailDraft({
      name: u.name,
      hq: u.hq ?? '',
      team: u.team ?? '',
      role_id: u.role?.id ?? 0,
    })
  }

  const closeDetail = () => {
    setDetailUserId(null)
    setDetailEditing(false)
    setDetailError(null)
  }

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
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openRoleDropdownUserId])

  if (isLoading) {
    return <div className="text-slate-300">{tr('adminUsers.loading', 'Loading...')}</div>
  }

  if (isError) {
    return <div className="text-slate-300">{tr('adminUsers.loadError', 'Failed to load users.')}</div>
  }

  const rows: Member[] = Array.isArray(users) ? users : []
  const isBlocked = reauthModalOpen
  const pendingRows = rows.filter((u) => u.role?.name === 'pending')

  const handleSort = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
      return
    }
    if (sortDir === 'asc') {
      setSortDir('desc')
      return
    }
    setSortKey(null)
  }

  const renderSortIcon = (key: NonNullable<SortKey>) => {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="inline w-3.5 h-3.5 text-slate-300 ml-1" />
    ) : (
      <ChevronDown className="inline w-3.5 h-3.5 text-slate-300 ml-1" />
    )
  }

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows
    const list = [...rows]
    const getValue = (u: Member): string => {
      switch (sortKey) {
        case 'name': return (u.name ?? '').toLowerCase()
        case 'email': return (u.email ?? '').toLowerCase()
        case 'hq': return (u.hq ?? '').toLowerCase()
        case 'team': return (u.team ?? '').toLowerCase()
        case 'role': return (u.role?.name ?? '').toLowerCase()
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (av === bv) return 0
      const cmp = av < bv ? -1 : 1
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [rows, sortKey, sortDir])

  const downloadCsvTemplate = () => {
    const bom = '\uFEFF'
    const hqNames = hqOptions.map((o) => o.name)
    const teamNames = teamOptions.map((o) => o.name)
    const comments = [
      `# Available HQ: ${hqNames.length > 0 ? hqNames.join(', ') : '(none registered)'}`,
      `# Available Team: ${teamNames.length > 0 ? teamNames.join(', ') : '(none registered)'}`,
      `# role: ${roles.filter((r) => r.name !== 'pending').map((r) => r.name).join(', ') || 'read, write, admin'}`,
    ].join('\n')
    const header = 'name,email,password,role,hq,team'
    const example = `Hong Gildong,hong@example.com,1234,read,${hqNames[0] || 'HQ'},${teamNames[0] || 'Team'}`
    const blob = new Blob([bom + comments + '\n' + header + '\n' + example + '\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'user_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      if (!text) return
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      if (lines.length < 2) return

      const parsed = lines.slice(1).map((line) => {
        const cols = line.split(',').map((c) => c.trim())
        const roleName = cols[3] || 'read'
        const matchedRole = roles.find((r) => r.name === roleName)
        return {
          name: cols[0] || '',
          email: cols[1] || '',
          password: cols[2] || '',
          role_id: matchedRole?.id ?? 0,
          hq: cols[4] || undefined,
          team: cols[5] || undefined,
        }
      }).filter((u) => u.name && u.email && u.password && u.role_id > 0)

      if (parsed.length === 0) return
      bulkCreateMutation.mutate(parsed)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const togglePendingSelect = (id: string) => {
    setPendingSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllPending = () => {
    if (pendingSelectedIds.size === pendingRows.length) {
      setPendingSelectedIds(new Set())
    } else {
      setPendingSelectedIds(new Set(pendingRows.map((u) => u.id)))
    }
  }

  const handlePendingBulkApprove = (roleName: string) => {
    const ids = Array.from(pendingSelectedIds)
    if (ids.length === 0) return
    const matchedRole = roles.find((r) => r.name === roleName)
    if (!matchedRole) return
    bulkUpdateRoleMutation.mutate({ userIds: ids, roleId: matchedRole.id })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('adminUsers.title', 'User management')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('adminUsers.subtitle', 'Update user roles (read/write/admin).')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingRows.length > 0 && (
            <button
              type="button"
              onClick={() => { setPendingSelectedIds(new Set()); setPendingModalOpen(true) }}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-4 py-2.5 text-sm text-amber-300 hover:bg-amber-950/40 transition-colors"
            >
              <Clock className="w-4 h-4" />
              {tr('adminUsers.pendingBtn', 'Pending')}
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-400">
                {pendingRows.length}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => { setBulkUploadResult(null); setBulkUploadModalOpen(true) }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <Upload className="w-4 h-4" />
            {tr('adminUsers.bulkUpload', 'Bulk upload')}
          </button>
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-500 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {tr('adminUsers.createUser', 'Add user')}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-visible">
        <table className="w-full text-sm">
          <thead className="bg-slate-800">
            <tr className="text-left text-slate-300">
              <th className="px-4 py-3 cursor-pointer select-none hover:text-white" onClick={() => handleSort('name')}>
                {tr('adminUsers.table.name', 'Name')}{renderSortIcon('name')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-white" onClick={() => handleSort('email')}>
                {tr('adminUsers.table.email', 'Email')}{renderSortIcon('email')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-white" onClick={() => handleSort('hq')}>
                {tr('adminUsers.table.hq', 'HQ')}{renderSortIcon('hq')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-white" onClick={() => handleSort('team')}>
                {tr('adminUsers.table.team', 'Team')}{renderSortIcon('team')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-white" onClick={() => handleSort('role')}>
                {tr('adminUsers.table.role', 'Role')}{renderSortIcon('role')}
              </th>
              <th className="px-4 py-3">{tr('adminUsers.table.password', 'Password')}</th>
              <th className="px-4 py-3">{tr('adminUsers.table.delete', 'Delete')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((u) => {
              const isUpdating = updateRoleMutation.isPending && updateRoleMutation.variables?.userId === u.id
              const isResetting = resetPasswordMutation.isPending && resetPasswordMutation.variables?.userId === u.id
              const isDeleting = deleteUserMutation.isPending && deleteUserMutation.variables?.userId === u.id
              const userRoleId = u.role?.id ?? 0
              const currentRoleId = roleDrafts[u.id] ?? userRoleId
              const currentRoleName = roles.find((r) => r.id === currentRoleId)?.name ?? u.role?.name ?? 'unknown'
              const isOpen = openRoleDropdownUserId === u.id
              const isSelf = !!me?.id && me.id === u.id
              const isPending = currentRoleName === 'pending'
              return (
                <tr
                  key={u.id}
                  className={`border-t border-slate-700 text-slate-200 ${isPending ? 'bg-amber-950/10' : ''}`}
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openDetail(u)}
                      className="text-left text-slate-100 hover:text-primary-300 hover:underline focus:outline-none focus:ring-2 focus:ring-primary-600 rounded"
                      title={tr('adminUsers.viewDetail', 'View details')}
                    >
                      {u.name}
                    </button>
                    {isPending && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
                        {tr('adminUsers.pendingBadge', 'Pending')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{u.email ?? '-'}</td>
                  <td className="px-4 py-3 text-slate-400">{u.hq || '-'}</td>
                  <td className="px-4 py-3 text-slate-400">{u.team || '-'}</td>
                  <td className="px-4 py-3">
                    <div
                      className="relative inline-block"
                      ref={(el) => {
                        if (isOpen) roleDropdownRef.current = el
                      }}
                    >
                      <button
                        type="button"
                        disabled={isUpdating || isBlocked}
                        onClick={() => setOpenRoleDropdownUserId((prev) => (prev === u.id ? null : u.id))}
                        className="w-32 inline-flex items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-none focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                        aria-haspopup="menu"
                        aria-expanded={isOpen}
                      >
                        <span className="truncate">
                          {tr(`adminUsers.roles.${currentRoleName}`, currentRoleName.toUpperCase())}
                        </span>
                        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {isOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 mt-2 w-32 rounded-xl border border-slate-700 bg-slate-900 shadow-xl z-50 overflow-hidden"
                        >
                          {roles.map((role) => {
                            const isSelected = currentRoleId === role.id
                            return (
                              <button
                                key={role.id}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenRoleDropdownUserId(null)
                                  if (role.id === currentRoleId) return
                                  setRoleDrafts((prev) => ({ ...prev, [u.id]: role.id }))
                                  updateRoleMutation.mutate({ userId: u.id, roleId: role.id })
                                }}
                                className={`w-full px-3 py-2 text-xs flex items-center gap-2 hover:bg-slate-800 transition-colors ${
                                  isSelected ? 'bg-slate-800 text-white' : 'text-slate-200'
                                }`}
                              >
                                <span className="flex-1 text-left">
                                  {tr(`adminUsers.roles.${role.name}`, role.name.toUpperCase())}
                                </span>
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
                      disabled={isResetting || isBlocked}
                      onClick={() => {
                        const ok = window.confirm(
                          tr('adminUsers.resetPasswordConfirm', 'Reset password to 1111?\\n\\nTarget: {{target}}', {
                            target: u.email ?? u.name,
                          })
                        )
                        if (!ok) return
                        resetPasswordMutation.mutate({ userId: u.id })
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/40 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-none focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                      title={tr('adminUsers.resetPasswordTitle', 'Reset password to 1111')}
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                      <span>
                        {isResetting
                          ? tr('adminUsers.resetting', 'Resetting...')
                          : tr('adminUsers.reset', 'Reset PW')}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={isDeleting || isSelf || isBlocked}
                      onClick={() => {
                        const ok = window.confirm(
                          tr(
                            'adminUsers.deleteConfirm',
                            'Delete this user?\\n\\nTarget: {{target}}\\n\\n* Deletions cannot be easily undone.',
                            { target: u.email ?? u.name }
                          )
                        )
                        if (!ok) return
                        deleteUserMutation.mutate({ userId: u.id })
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/60 bg-red-950/20 px-2.5 py-2 text-xs text-red-200 hover:bg-red-950/35 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:opacity-50"
                      title={
                        isSelf
                          ? tr('adminUsers.deleteSelfBlocked', 'You cannot delete your own account.')
                          : tr('adminUsers.deleteTitle', 'Delete user')
                      }
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-300" />
                      <span>
                        {isDeleting ? tr('adminUsers.deleting', 'Deleting...') : tr('adminUsers.delete', 'Delete')}
                      </span>
                    </button>
                  </td>
                </tr>
              )
            })}
            {sortedRows.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-slate-300" colSpan={7}>
                  {tr('adminUsers.empty', 'No users found.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* User detail modal */}
      {detailUserId && (() => {
        const u = rows.find((x) => x.id === detailUserId)
        if (!u) return null
        const userRole = roles.find((r) => r.id === (detailEditing ? detailDraft.role_id : u.role?.id ?? 0))
        const permissions = userRole?.permissions ?? []
        return (
          <ModalOverlay onClose={closeDetail}>
            <div
              className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl max-h-[85vh] flex flex-col"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10 border border-primary-500/20">
                    <span className="text-sm font-semibold text-primary-300">
                      {u.name.slice(0, 1).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      {tr('adminUsers.detail.title', 'User details')}
                    </h2>
                    <p className="text-sm text-slate-400">{u.email ?? '-'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canEditUsers && !detailEditing && (
                    <button
                      type="button"
                      onClick={() => { setDetailEditing(true); setDetailError(null) }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      {tr('adminUsers.detail.edit', 'Edit')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={closeDetail}
                    className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-slate-800"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto pr-1 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {tr('adminUsers.form.name', 'Name')}
                    </label>
                    {detailEditing ? (
                      <input
                        value={detailDraft.name}
                        onChange={(e) => setDetailDraft((p) => ({ ...p, name: e.target.value }))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                      />
                    ) : (
                      <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-200">{u.name}</div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {tr('adminUsers.form.email', 'Email')}
                    </label>
                    <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-300">{u.email ?? '-'}</div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {tr('adminUsers.form.hq', 'HQ')}
                    </label>
                    {detailEditing ? (
                      <select
                        value={detailDraft.hq}
                        onChange={(e) => setDetailDraft((p) => ({ ...p, hq: e.target.value }))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                      >
                        <option value="">{tr('adminUsers.form.selectHq', 'Select HQ')}</option>
                        {hqOptions.map((o) => (
                          <option key={o.id} value={o.name}>{o.name}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-200">{u.hq || '-'}</div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {tr('adminUsers.form.team', 'Team')}
                    </label>
                    {detailEditing ? (
                      <select
                        value={detailDraft.team}
                        onChange={(e) => setDetailDraft((p) => ({ ...p, team: e.target.value }))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                      >
                        <option value="">{tr('adminUsers.form.selectTeam', 'Select Team')}</option>
                        {teamOptions.map((o) => (
                          <option key={o.id} value={o.name}>{o.name}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-200">{u.team || '-'}</div>
                    )}
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {tr('adminUsers.form.role', 'Role')}
                    </label>
                    {detailEditing ? (
                      <select
                        value={detailDraft.role_id}
                        onChange={(e) => setDetailDraft((p) => ({ ...p, role_id: Number(e.target.value) }))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                      >
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-200">
                        {u.role?.name ?? '-'}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                    {tr('adminUsers.detail.permissions', 'Permissions')}
                  </h3>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-950/30 p-3">
                    {permissions.length === 0 ? (
                      <p className="text-xs text-slate-500">{tr('adminUsers.detail.noPerms', 'No permissions assigned')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {permissions.map((p) => (
                          <span
                            key={p}
                            className="inline-block rounded bg-slate-800 px-2 py-0.5 text-[11px] font-mono text-slate-300 border border-slate-700"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {detailError && (
                <div className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  {detailError}
                </div>
              )}

              <div className="mt-5 flex items-center justify-end gap-3">
                {detailEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setDetailEditing(false)
                        setDetailError(null)
                        setDetailDraft({
                          name: u.name,
                          hq: u.hq ?? '',
                          team: u.team ?? '',
                          role_id: u.role?.id ?? 0,
                        })
                      }}
                      className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      {tr('adminUsers.form.cancel', 'Cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={updateUserMutation.isPending || !detailDraft.name.trim()}
                      onClick={() => {
                        const payload: { name?: string; hq?: string; team?: string; role_id?: number } = {}
                        if (detailDraft.name.trim() !== u.name) payload.name = detailDraft.name.trim()
                        if (detailDraft.hq !== (u.hq ?? '')) payload.hq = detailDraft.hq
                        if (detailDraft.team !== (u.team ?? '')) payload.team = detailDraft.team
                        if (detailDraft.role_id !== (u.role?.id ?? 0)) payload.role_id = detailDraft.role_id
                        if (Object.keys(payload).length === 0) {
                          setDetailEditing(false)
                          return
                        }
                        updateUserMutation.mutate({ userId: u.id, payload })
                      }}
                      className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
                    >
                      {updateUserMutation.isPending
                        ? tr('adminUsers.detail.saving', 'Saving...')
                        : tr('adminUsers.detail.save', 'Save')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={closeDetail}
                    className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                  >
                    {tr('adminUsers.detail.close', 'Close')}
                  </button>
                )}
              </div>
            </div>
          </ModalOverlay>
        )
      })()}

      {/* Pending approval modal */}
      {pendingModalOpen && (
        <ModalOverlay>
          <div
            className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/20">
                <Clock className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {tr('adminUsers.pendingModal.title', 'Pending approval')}
                </h2>
                <p className="text-sm text-slate-400">
                  {tr('adminUsers.pendingModal.subtitle', 'Select users to approve and assign a role.')}
                </p>
              </div>
            </div>

            {pendingRows.length === 0 ? (
              <div className="mt-6 text-center text-sm text-slate-400 py-8">
                {tr('adminUsers.pendingModal.empty', 'No pending users.')}
              </div>
            ) : (
              <>
                <div className="mt-5 rounded-xl border border-slate-700 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-800">
                      <tr className="text-left text-slate-300">
                        <th className="px-3 py-2.5 w-10">
                          <input
                            type="checkbox"
                            checked={pendingSelectedIds.size === pendingRows.length && pendingRows.length > 0}
                            onChange={toggleAllPending}
                            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-primary-600 focus:ring-primary-600 focus:ring-offset-0"
                          />
                        </th>
                        <th className="px-3 py-2.5">{tr('adminUsers.table.name', 'Name')}</th>
                        <th className="px-3 py-2.5">{tr('adminUsers.table.email', 'Email')}</th>
                        <th className="px-3 py-2.5">{tr('adminUsers.form.hq', 'HQ')}</th>
                        <th className="px-3 py-2.5">{tr('adminUsers.form.team', 'Team')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingRows.map((u) => {
                        const isChecked = pendingSelectedIds.has(u.id)
                        return (
                          <tr
                            key={u.id}
                            className={`border-t border-slate-700 text-slate-200 cursor-pointer hover:bg-slate-800/50 ${isChecked ? 'bg-primary-950/20' : ''}`}
                            onClick={() => togglePendingSelect(u.id)}
                          >
                            <td className="px-3 py-2.5">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => togglePendingSelect(u.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-primary-600 focus:ring-primary-600 focus:ring-offset-0"
                              />
                            </td>
                            <td className="px-3 py-2.5">{u.name}</td>
                            <td className="px-3 py-2.5 text-slate-400">{u.email ?? '-'}</td>
                            <td className="px-3 py-2.5 text-slate-500">{u.hq ?? '-'}</td>
                            <td className="px-3 py-2.5 text-slate-500">{u.team ?? '-'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  {pendingSelectedIds.size > 0 && (
                    <span className="text-xs text-slate-400">
                      {tr('adminUsers.bulk.selected', '{{count}} selected', { count: pendingSelectedIds.size })}
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => handlePendingBulkApprove('read')}
                    disabled={pendingSelectedIds.size === 0 || bulkUpdateRoleMutation.isPending}
                    className="rounded-lg bg-green-600/80 px-4 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-40"
                  >
                    {tr('adminUsers.bulk.approveRead', 'Approve as READ')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePendingBulkApprove('write')}
                    disabled={pendingSelectedIds.size === 0 || bulkUpdateRoleMutation.isPending}
                    className="rounded-lg bg-blue-600/80 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-40"
                  >
                    {tr('adminUsers.bulk.approveWrite', 'Approve as WRITE')}
                  </button>
                </div>
              </>
            )}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setPendingModalOpen(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                {tr('adminUsers.pendingModal.close', 'Close')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Bulk upload modal */}
      {bulkUploadModalOpen && (
        <ModalOverlay>
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-white">
              {tr('adminUsers.bulkUploadTitle', 'Bulk upload users')}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {tr('adminUsers.bulkUploadDesc', 'Download the CSV template, fill in user data, and upload it.')}
            </p>

            <div className="mt-5 space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">1</span>
                <span className="flex-1 text-sm text-slate-300">{tr('adminUsers.bulkStep1', 'Download CSV template')}</span>
                <button
                  type="button"
                  onClick={downloadCsvTemplate}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-white hover:bg-slate-600"
                >
                  <Download className="w-3.5 h-3.5" />
                  {tr('adminUsers.bulkDownload', 'Download')}
                </button>
              </div>

              <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-600/20 text-xs font-bold text-primary-400">2</span>
                <span className="flex-1 text-sm text-slate-300">{tr('adminUsers.bulkStep2', 'Upload filled CSV file')}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={bulkCreateMutation.isPending}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs text-white hover:bg-primary-500 disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {bulkCreateMutation.isPending
                    ? tr('adminUsers.bulkUploading', 'Uploading...')
                    : tr('adminUsers.bulkUploadBtn', 'Upload')}
                </button>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-4 py-3">
                <p className="text-xs text-slate-500 mb-1">{tr('adminUsers.bulkFormat', 'CSV format:')}</p>
                <code className="text-xs text-slate-400">name,email,password,role,hq,team</code>
              </div>

              {bulkUploadResult && (
                <div className="space-y-2">
                  {bulkUploadResult.created.length > 0 && (
                    <div className="rounded-lg border border-green-800/40 bg-green-950/20 px-4 py-2 text-sm text-green-300">
                      {tr('adminUsers.bulkCreated', '{{count}} users created.', { count: bulkUploadResult.created.length })}
                    </div>
                  )}
                  {bulkUploadResult.errors?.length > 0 && (
                    <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-4 py-2 text-sm text-red-300 space-y-1">
                      {bulkUploadResult.errors.map((err, i) => (
                        <div key={i}>{err.email}: {err.message}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => { setBulkUploadModalOpen(false); setBulkUploadResult(null) }}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                {tr('adminUsers.form.cancel', 'Cancel')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Create user modal */}
      {createModalOpen && (
        <ModalOverlay>
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={tr('adminUsers.createUserTitle', 'Add user')}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-white">
              {tr('adminUsers.createUserTitle', 'Add user')}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {tr('adminUsers.createUserSubtitle', 'Create a new user account with a specified role.')}
            </p>

            <form
              className="mt-5 space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newUser.name || !newUser.email || !newUser.password || !newUser.role_id) return
                createUserMutation.mutate()
              }}
            >
              <div>
                <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.name', 'Name')}</label>
                <input
                  value={newUser.name}
                  onChange={(e) => setNewUser((p) => ({ ...p, name: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('adminUsers.form.namePlaceholder', 'Jane Doe')}
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.hq', 'HQ')}</label>
                  <select
                    value={newUser.hq}
                    onChange={(e) => setNewUser((p) => ({ ...p, hq: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                  >
                    <option value="">{tr('adminUsers.form.selectHq', 'Select HQ')}</option>
                    {hqOptions.map((o) => (
                      <option key={o.id} value={o.name}>{o.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.team', 'Team')}</label>
                  <select
                    value={newUser.team}
                    onChange={(e) => setNewUser((p) => ({ ...p, team: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                  >
                    <option value="">{tr('adminUsers.form.selectTeam', 'Select Team')}</option>
                    {teamOptions.map((o) => (
                      <option key={o.id} value={o.name}>{o.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.email', 'Email')}</label>
                <input
                  value={newUser.email}
                  onChange={(e) => setNewUser((p) => ({ ...p, email: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder="user@example.com"
                  type="email"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.password', 'Password')}</label>
                <input
                  value={newUser.password}
                  onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('adminUsers.form.passwordPlaceholder', 'Initial password')}
                  type="password"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.role', 'Role')}</label>
                <select
                  value={newUser.role_id}
                  onChange={(e) => setNewUser((p) => ({ ...p, role_id: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
                >
                  <option value={0}>{tr('adminUsers.form.selectRole', 'Select role')}</option>
                  {roles.filter((r) => r.name !== 'pending').map((r) => (
                    <option key={r.id} value={r.id}>{r.name.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              {createUserMutation.isError && (
                <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  {tr('adminUsers.createUserError', 'Failed to create user.')}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setCreateModalOpen(false)
                    setNewUser({ name: '', email: '', password: '', role_id: 0, hq: '', team: '' })
                  }}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  {tr('adminUsers.form.cancel', 'Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createUserMutation.isPending || !newUser.name || !newUser.email || !newUser.password || !newUser.role_id}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
                >
                  {createUserMutation.isPending
                    ? tr('adminUsers.form.creating', 'Creating...')
                    : tr('adminUsers.form.create', 'Create')}
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {reauthModalOpen && (
        <ModalOverlay>
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={tr('adminUsers.reauth.ariaLabel', 'Re-authentication required')}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-white">
              {tr('adminUsers.reauth.title', 'Role updated')}
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              {tr('adminUsers.reauth.subtitle', 'For security, please sign in again. You will be taken to the login page.')}
            </p>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  clearAccessToken()
                  queryClient.clear()
                  navigate('/login', { replace: true })
                }}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500"
              >
                {tr('adminUsers.reauth.confirm', 'OK')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
