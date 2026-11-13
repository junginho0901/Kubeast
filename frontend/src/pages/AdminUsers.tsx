import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member, type BulkCreateAnswer } from '@/services/api'
import { CheckCircle, ChevronDown, ChevronUp, Clock, Copy, Download, KeyRound, Lock, Plus, RotateCcw, Search, Trash2, Unlock, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListPager } from '@/components/ListPager'
import { ModalOverlay } from '@/components/ModalOverlay'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { usePagination } from '@/components/resource-detail/usePagination'
import { useTranslation } from 'react-i18next'
import { usePermission } from '@/hooks/usePermission'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { formatTime } from '@/utils/time'
import { pageOf } from '@/utils/listPages'
import { useAdminUserData } from './admin-users/useAdminUserData'
import { ReauthModal } from './admin-users/ReauthModal'
import { CreateUserModal } from './admin-users/CreateUserModal'
import { useConfirm } from '@/services/confirm'
import { logoutSession } from '@/services/auth'
import { useNavigate } from 'react-router-dom'
import { UserDetailModal } from './admin-users/UserDetailModal'
import { bulkRoleFailures, bulkRoleFailureText, readBulkRoleAnswer } from './admin-users/bulkRole'
import { BULK_CSV_HEADER, bulkCreateFailureRows, bulkCreateFailures, bulkCreateSummary, bulkCsvTemplate, exampleBulkPassword, parseBulkCsv, readBulkCreateAnswer, type ParsedBulkCsv } from './admin-users/bulkCreate'
import { roleMenuOpensUp } from './admin-users/roleMenu'
import { failureText } from '@/utils/failureText'
import { copyText } from '@/utils/clipboard'
import { allPendingSelected, toggleAllPending as toggleAllPendingIds, toggleOnePending } from './admin-users/pendingSelection'
import { useDismiss } from '@/hooks/useDismiss'
import { announceCreated } from '@/services/createdNoticeStore'
import { CreatedNotice } from '@/components/CreatedNotice'

const USER_COLUMNS = 6

export default function AdminUsers() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const confirm = useConfirm()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [roleDrafts, setRoleDrafts] = useState<Record<string, number>>({})
  const [openRoleDropdownUserId, setOpenRoleDropdownUserId] = useState<string | null>(null)
  const closeRoleDropdown = useCallback(() => setOpenRoleDropdownUserId(null), [])
  const [roleMenuUp, setRoleMenuUp] = useState(false)
  const roleDropdownRef = useRef<HTMLDivElement | null>(null)
  const [reauthModalOpen, setReauthModalOpen] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role_id: 0, team: '' })

  // Pending modal
  const [pendingModalOpen, setPendingModalOpen] = useState(false)
  const [pendingSelectedIds, setPendingSelectedIds] = useState<Set<string>>(new Set())

  // Bulk upload
  const [bulkUploadModalOpen, setBulkUploadModalOpen] = useState(false)
  const [bulkUploadResult, setBulkUploadResult] = useState<(BulkCreateAnswer & { total: number; error?: string }) | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Sorting
  type SortKey = 'name' | 'email' | 'team' | 'role' | null
  type SortDir = 'asc' | 'desc'
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  // User detail modal
  const [detailUserId, setDetailUserId] = useState<string | null>(null)
  const [detailEditing, setDetailEditing] = useState(false)
  const [detailDraft, setDetailDraft] = useState<{ name: string; team: string; role_id: number }>({
    name: '', team: '', role_id: 0,
  })
  const [detailError, setDetailError] = useState<string | null>(null)
  const { has: hasPerm } = usePermission()
  const canEditUsers = hasPerm('admin.users.update')

  const { teamOptions, roles, me, users, isLoading, isError, error: usersError } = useAdminUserData({ reauthModalOpen })

  // A row action the server refuses says why: e.g. an account that holds more than this admin.
  const [actionError, setActionError] = useState<string | null>(null)
  const showActionError = (err: any) =>
    setActionError(err?.response?.data?.detail || err?.message || tr('adminUsers.actionFailed', 'The action failed.'))

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: number }) => api.adminUpdateUserRole(userId, roleId),
    onMutate: () => setActionError(null),
    onSuccess: (_data, vars) => {
      const roleName = roles.find((r) => r.id === vars.roleId)?.name
      if (me?.id && vars.userId === me.id && roleName !== 'admin') {
        setReauthModalOpen(true)
        return
      }
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (err, vars) => {
      showActionError(err)
      setRoleDrafts((prev) => {
        const next = { ...prev }
        delete next[vars.userId]
        return next
      })
    },
  })

  const bulkUpdateRoleMutation = useMutation({
    mutationFn: async ({ userIds, roleId }: { userIds: string[]; roleId: number }) => readBulkRoleAnswer(await api.adminBulkUpdateRole(userIds, roleId)),
    onMutate: () => setActionError(null),
    onSuccess: ({ failed }, vars) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      if (failed.length > 0) {
        // The window stays with the accounts that are left, so what happened is on screen and they can be tried again.
        setActionError(bulkRoleFailureText(t, vars.userIds.length, failed))
        setPendingSelectedIds(new Set(failed.filter((f) => f.reason === 'failed').map((f) => f.user_id)))
        return
      }
      setPendingSelectedIds(new Set())
      setPendingModalOpen(false)
    },
    onError: (err, vars) => {
      const failed = bulkRoleFailures(err)
      if (failed.length > 0) setActionError(bulkRoleFailureText(t, vars.userIds.length, failed))
      else showActionError(err)
    },
  })

  // 비번 재발급 결과 (1회용 평문) — 모달로 한 번 보여주고 닫히면 잊어버림
  const [resetResult, setResetResult] = useState<{ targetLabel: string; password: string; self: boolean } | null>(null)
  const [resetCopied, setResetCopied] = useState(false)
  // the password is shown only this once: a refused copy says so and stays
  const [resetCopyFailed, setResetCopyFailed] = useState(false)
  const navigate = useNavigate()
  // One's own reset: the server kept this session so the window could show the password; closing it signs out
  // to the login page, where the new password signs in.
  const closeResetResult = () => {
    const self = resetResult?.self
    setResetResult(null)
    if (self) {
      void logoutSession()
      queryClient.clear()
      navigate('/login')
    }
  }

  // Dormant accounts: "sweep now" appears when the sweeper is on; the lock
  // badge and the unlock button show for any locked account either way.
  const { data: dormantConfig } = useQuery({ queryKey: ['dormant-accounts', 'config'], queryFn: api.getDormantAccountsConfig, staleTime: 60_000, retry: false })
  const [sweepMessage, setSweepMessage] = useState<string | null>(null)
  const sweepMutation = useMutation({
    mutationFn: () => api.adminDormantSweep(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setSweepMessage(tr('adminUsers.sweepDone', 'Sweep done: {{count}} account(s) locked.', { count: res.locked }))
    },
    onError: (err) => setSweepMessage(tr('adminUsers.sweepFailed', 'The sweep failed: {{reason}}', { reason: failureText(err) })),
  })
  const unlockMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.adminUnlockUser(userId),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: showActionError,
  })
  const isLocked = (u: Member) => !!u.dormant_locked_at || (!!u.locked_until && new Date(u.locked_until).getTime() > Date.now())

  const resetPasswordMutation = useMutation({
    mutationFn: ({ userId, targetLabel }: { userId: string; targetLabel: string }) =>
      api.adminResetUserPassword(userId).then((res) => ({ res, targetLabel })),
    onMutate: () => setActionError(null),
    onSuccess: ({ res, targetLabel }, { userId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setResetCopied(false)
      setResetCopyFailed(false)
      setResetResult({ targetLabel, password: res.temporary_password, self: !!me?.id && userId === me.id })
    },
    onError: showActionError,
  })

  const deleteUserMutation = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.adminDeleteUser(userId),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: showActionError,
  })

  const createUserMutation = useMutation({
    mutationFn: () => api.adminCreateUser({
      name: newUser.name,
      email: newUser.email,
      password: newUser.password,
      role_id: newUser.role_id,
      team: newUser.team || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreateModalOpen(false)
      // the new account may sit on another page of the list: the line at the top of the page names it
      announceCreated(window.location.pathname, [{ kind: 'User', name: `${newUser.name} (${newUser.email})` }])
      setNewUser({ name: '', email: '', password: '', role_id: 0, team: '' })
    },
  })

  const bulkCreateMutation = useMutation({
    mutationFn: ({ users }: ParsedBulkCsv) => api.adminBulkCreateUsers(users),
    onSuccess: (result, { users, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      const answer = readBulkCreateAnswer(result)
      setBulkUploadResult({ created: answer.created, failed: [...failed, ...answer.failed], total: users.length + failed.length })
    },
    onError: (err: any, { users, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      const leftOut = bulkCreateFailures(err)
      setBulkUploadResult({
        created: [],
        failed: [...failed, ...leftOut],
        total: users.length + failed.length,
        error: leftOut.length > 0 ? undefined : err?.response?.data?.detail || err?.message || tr('adminUsers.actionFailed', 'The action failed.'),
      })
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, payload }: { userId: string; payload: { name?: string; team?: string; role_id?: number } }) =>
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
      // The server answers {detail}: e.g. a permission-ceiling refusal.
      setDetailError(err?.response?.data?.detail || err?.response?.data?.error || err?.message || 'Failed to update user')
    },
  })

  const openDetail = (u: Member) => {
    setDetailUserId(u.id)
    setDetailEditing(false)
    setDetailError(null)
    setDetailDraft({
      name: u.name,
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

  useDismiss(Boolean(openRoleDropdownUserId), roleDropdownRef, closeRoleDropdown)

  const rows: Member[] = useMemo(() => (Array.isArray(users) ? users : []), [users])

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows
    const list = [...rows]
    const getValue = (u: Member): string => {
      switch (sortKey) {
        case 'name': return (u.name ?? '').toLowerCase()
        case 'email': return (u.email ?? '').toLowerCase()
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

  const query = search.trim().toLowerCase()
  const filteredRows = useMemo(
    () => (query
      ? sortedRows.filter((u) => [u.name, u.email, u.team].some((v) => (v ?? '').toLowerCase().includes(query)))
      : sortedRows),
    [sortedRows, query],
  )
  // the table takes the screen's height left; its rows per page are what fits (or the footer's fixed choice)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: `${isLoading}:${filteredRows.length}` })
  const { rows: pagedRows, page: currentPage, pages: pageCount } = pageOf(filteredRows, page, rowsPerPage)
  // role names are stored capitalized ("Pending"), so compare without case
  const pendingRows = useMemo(() => rows.filter((u) => u.role?.name?.toLowerCase() === 'pending'), [rows])
  const pendingIds = useMemo(() => pendingRows.map((u) => u.id), [pendingRows])
  // the Pending window pages its accounts as a drawer's table does; the choice is kept by id across its pages
  const { items: pendingPageRows, nav: pendingNav } = usePagination(pendingRows, 10)
  // a bulk upload's rows that were not created (up to the server's 100 a request), ten at a time
  const bulkFailureLines = useMemo(() => (bulkUploadResult ? bulkCreateFailureRows(t, bulkUploadResult.failed) : []), [bulkUploadResult, t])
  const { items: bulkFailureRows, nav: bulkFailureNav } = usePagination(bulkFailureLines, 10)

  if (isLoading) {
    return <div className="text-slate-300">{tr('adminUsers.loading', 'Loading...')}</div>
  }

  if (isError) {
    return <div role="alert" data-testid="users-read-failed" className="text-red-400 break-words">{tr('common.readFailed', 'Could not read the list: {{reason}}', { reason: failureText(usersError) })}</div>
  }

  const isBlocked = reauthModalOpen

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

  const downloadCsvTemplate = () => {
    const bom = '\uFEFF'
    const template = bulkCsvTemplate(teamOptions.map((o) => o.name), roles, exampleBulkPassword())
    const blob = new Blob([bom + template], { type: 'text/csv;charset=utf-8' })
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
      const parsed = parseBulkCsv(text, roles)
      if (parsed.users.length > 0) {
        bulkCreateMutation.mutate(parsed)
      } else if (parsed.failed.length > 0) {
        setBulkUploadResult({ created: [], failed: parsed.failed, total: parsed.failed.length })
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const togglePendingSelect = (id: string) => setPendingSelectedIds((prev) => toggleOnePending(prev, id))
  // every pending account, on every page of the window
  const toggleAllPending = () => setPendingSelectedIds((prev) => toggleAllPendingIds(prev, pendingIds))

  const handlePendingBulkApprove = (roleName: string) => {
    // every account chosen, on any page; one gone meanwhile is sent too, so the answer names it
    const ids = Array.from(pendingSelectedIds)
    if (ids.length === 0) return
    const matchedRole = roles.find((r) => r.name === roleName)
    if (!matchedRole) return
    bulkUpdateRoleMutation.mutate({ userIds: ids, roleId: matchedRole.id })
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="page-head items-start shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink">{tr('adminUsers.title', 'User management')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('adminUsers.subtitle', 'Update user roles (read/write/admin).')}
          </p>
          {sweepMessage && (
            <p className="mt-2 text-sm text-slate-300" data-testid="dormant-sweep-result">{sweepMessage}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {pendingRows.length > 0 && (
            <button
              type="button"
              onClick={() => { setPendingSelectedIds(new Set()); setPendingModalOpen(true) }}
              className="btn btn-primary flex items-center gap-2"
            >
              <Clock className="w-4 h-4" />
              {tr('adminUsers.pendingBtn', 'Pending')}
              <span className="rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-slate-900">
                {pendingRows.length}
              </span>
            </button>
          )}
          {dormantConfig?.enabled && (
            <button
              type="button"
              onClick={async () => {
                // it locks accounts at once: say what it does and to whom before it runs
                const ok = await confirm({
                  title: tr('adminUsers.sweepConfirmTitle', 'Sweep dormant accounts now'),
                  message: tr('adminUsers.sweepConfirm', 'Lock every account with no sign-in or API key use for {{days}} days now? A locked account signs in again only after an admin unlocks it.', { days: dormantConfig.days }),
                  confirmLabel: tr('adminUsers.sweepDormant', 'Sweep dormant now'),
                  danger: true,
                })
                if (ok) sweepMutation.mutate()
              }}
              disabled={sweepMutation.isPending}
              data-testid="dormant-sweep-now"
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
              title={tr('adminUsers.sweepTitle', 'Lock accounts with no sign-in or API key use for {{days}} days (runs daily on its own)', { days: dormantConfig.days })}
            >
              <Lock className="w-4 h-4" />
              {sweepMutation.isPending ? tr('adminUsers.sweeping', 'Sweeping...') : tr('adminUsers.sweepDormant', 'Sweep dormant now')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { setBulkUploadResult(null); setBulkUploadModalOpen(true) }}
            className="btn btn-primary flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            {tr('adminUsers.bulkUpload', 'Bulk upload')}
          </button>
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="btn btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            {tr('adminUsers.createUser', 'Add user')}
          </button>
        </div>
      </div>

      {actionError && (
        <div className="shrink-0 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200" role="alert" data-testid="admin-users-action-error">
          {actionError}
        </div>
      )}
      {/* an account just added: named here, inside the page's height, until closed or another page opens */}
      <CreatedNotice />

      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          placeholder={tr('adminUsers.searchPlaceholder', 'Search by name, email or team...')}
          data-testid="admin-users-search"
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 flex flex-col rounded-2xl border border-slate-700 bg-slate-800/50">
        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm">
          <thead ref={theadRef} className="bg-slate-800 text-slate-400">
            <tr className="text-left">
              <th className="px-4 py-3 cursor-pointer select-none hover:text-ink" onClick={() => handleSort('name')}>
                {tr('adminUsers.table.name', 'Name')}{renderSortIcon('name')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-ink" onClick={() => handleSort('email')}>
                {tr('adminUsers.table.email', 'Email')}{renderSortIcon('email')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-ink" onClick={() => handleSort('team')}>
                {tr('adminUsers.table.team', 'Team')}{renderSortIcon('team')}
              </th>
              <th className="px-4 py-3 cursor-pointer select-none hover:text-ink" onClick={() => handleSort('role')}>
                {tr('adminUsers.table.role', 'Role')}{renderSortIcon('role')}
              </th>
              <th className="px-4 py-3">{tr('adminUsers.table.password', 'Password')}</th>
              <th className="px-4 py-3">{tr('adminUsers.table.delete', 'Delete')}</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((u, idx) => {
              const isUpdating = updateRoleMutation.isPending && updateRoleMutation.variables?.userId === u.id
              const isResetting = resetPasswordMutation.isPending && resetPasswordMutation.variables?.userId === u.id
              const isDeleting = deleteUserMutation.isPending && deleteUserMutation.variables?.userId === u.id
              const userRoleId = u.role?.id ?? 0
              const currentRoleId = roleDrafts[u.id] ?? userRoleId
              const currentRoleName = roles.find((r) => r.id === currentRoleId)?.name ?? u.role?.name ?? 'unknown'
              const isOpen = openRoleDropdownUserId === u.id
              const isSelf = !!me?.id && me.id === u.id
              const isPending = currentRoleName.toLowerCase() === 'pending'
              return (
                <tr
                  key={u.id}
                  ref={idx === 0 ? firstRowRef : undefined}
                  className={`border-t border-slate-700 text-slate-200 ${isPending ? 'bg-amber-950/10' : ''}`}
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      data-testid={`user-detail-${u.email ?? u.id}`}
                      onClick={() => openDetail(u)}
                      className="text-left text-slate-100 hover:text-primary-300 hover:underline focus:outline-hidden focus:ring-2 focus:ring-primary-600 rounded-sm"
                      title={tr('adminUsers.viewDetail', 'View details')}
                    >
                      {u.name}
                    </button>
                    {isPending && (
                      <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
                        {tr('adminUsers.pendingBadge', 'Pending')}
                      </span>
                    )}
                    {u.dormant_locked_at ? (
                      <span
                        className="ml-2 inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-300 border border-red-500/20"
                        data-testid="user-dormant-badge"
                        title={tr('adminUsers.lastLogin', 'Last login {{when}}', { when: u.last_login_at ? formatTime(u.last_login_at) : tr('adminUsers.neverLoggedIn', 'never signed in') })}
                      >
                        {tr('adminUsers.dormantBadge', 'Dormant lock')}
                      </span>
                    ) : isLocked(u) ? (
                      <span className="ml-2 inline-flex items-center rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-medium text-yellow-300 border border-yellow-500/20" data-testid="user-locked-badge">
                        {tr('adminUsers.lockedBadge', 'Locked')}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{u.email ?? '-'}</td>
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
                        onClick={(e) => {
                          // the table scrolls inside its card: near its bottom the menu opens upward, where it is not cut off
                          const table = bodyRef.current?.getBoundingClientRect()
                          setRoleMenuUp(!!table && roleMenuOpensUp(table.bottom, e.currentTarget.getBoundingClientRect().bottom))
                          setOpenRoleDropdownUserId((prev) => (prev === u.id ? null : u.id))
                        }}
                        className="w-32 inline-flex items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-900/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-hidden focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                        aria-haspopup="menu"
                        aria-expanded={isOpen}
                      >
                        <span className="truncate">
                          {currentRoleName}
                        </span>
                        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {isOpen && (
                        <div
                          role="menu"
                          data-placement={roleMenuUp ? 'up' : 'down'}
                          className={`absolute right-0 ${roleMenuUp ? 'bottom-full mb-2' : 'mt-2'} w-32 rounded-xl border border-slate-700 bg-slate-900 shadow-xl z-50 overflow-hidden`}
                        >
                          {/* Inline row dropdown sets the GLOBAL role → account
                              level only (Admin/Member/Pending). Read/Write are
                              granted per-cluster, not here. */}
                          {roles
                            .filter((r) => ['Admin', 'Member', 'Pending'].includes(r.name))
                            .map((role) => {
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
                                  isSelected ? 'bg-slate-800 text-ink' : 'text-slate-200'
                                }`}
                              >
                                <span className="flex-1 text-left">
                                  {role.name}
                                </span>
                                {isSelected && <CheckCircle className="w-4 h-4 text-primary-400 shrink-0" />}
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
                      onClick={async () => {
                        const targetLabel = u.email ?? u.name
                        const ok = await confirm({
                          title: tr('adminUsers.resetPasswordTitle', 'Issue temporary password'),
                          message: tr('adminUsers.resetPasswordConfirm', 'Generate a new random password?\n\nTarget: {{target}}', { target: targetLabel }),
                          confirmLabel: tr('adminUsers.reset', 'Reset PW'),
                        })
                        if (!ok) return
                        resetPasswordMutation.mutate({ userId: u.id, targetLabel })
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/40 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-900/60 focus:outline-hidden focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                      title={tr('adminUsers.resetPasswordTitle', 'Reset to random password')}
                      data-testid="user-reset-password"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                      <span>
                        {isResetting
                          ? tr('adminUsers.resetting', 'Resetting...')
                          : tr('adminUsers.reset', 'Reset PW')}
                      </span>
                    </button>
                    {isLocked(u) && (
                      <button
                        type="button"
                        disabled={isBlocked || (unlockMutation.isPending && unlockMutation.variables?.userId === u.id)}
                        onClick={async () => {
                          const ok = await confirm({
                            title: tr('adminUsers.unlockDialogTitle', 'Unlock account'),
                            message: tr('adminUsers.unlockConfirm', 'Unlock this account?\n\nTarget: {{target}}', { target: u.email ?? u.name }),
                            confirmLabel: tr('adminUsers.unlock', 'Unlock'),
                          })
                          if (!ok) return
                          unlockMutation.mutate({ userId: u.id })
                        }}
                        data-testid="user-unlock"
                        className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-yellow-700/60 bg-yellow-950/20 px-2.5 py-2 text-xs text-yellow-200 hover:bg-yellow-950/35 focus:outline-hidden focus:ring-2 focus:ring-yellow-600 disabled:opacity-50"
                        title={tr('adminUsers.unlockTitle', 'Clear the dormant lock and the password lock')}
                      >
                        <Unlock className="w-3.5 h-3.5 text-yellow-300" />
                        <span>
                          {unlockMutation.isPending && unlockMutation.variables?.userId === u.id
                            ? tr('adminUsers.unlocking', 'Unlocking...')
                            : tr('adminUsers.unlock', 'Unlock')}
                        </span>
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <span className="text-xs text-slate-500" title={tr('adminUsers.deleteSelfBlocked', 'You cannot delete your own account.')} data-testid="admin-users-self">
                        {tr('adminUsers.selfAccount', 'Your account')}
                      </span>
                    ) : (
                    <button
                      type="button"
                      disabled={isDeleting || isBlocked}
                      onClick={async () => {
                        const ok = await confirm({
                          title: tr('adminUsers.deleteTitle', 'Delete user'),
                          message: tr('adminUsers.deleteConfirm', 'Delete this user?\n\nTarget: {{target}}\n\n* Deletions cannot be easily undone.', { target: u.email ?? u.name }),
                          confirmLabel: tr('adminUsers.delete', 'Delete'),
                          danger: true,
                        })
                        if (!ok) return
                        deleteUserMutation.mutate({ userId: u.id })
                      }}
                      className="btn-row-danger"
                      title={tr('adminUsers.deleteTitle', 'Delete user')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>
                        {isDeleting ? tr('adminUsers.deleting', 'Deleting...') : tr('adminUsers.delete', 'Delete')}
                      </span>
                    </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {filteredRows.length === 0 && <TableEmptyRow colSpan={USER_COLUMNS} resource="admin-users" searching={!!query} />}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - pagedRows.length} columnCount={USER_COLUMNS} />
        </table>
        </div>
        <ListPager
          currentPage={currentPage}
          totalPages={pageCount}
          total={filteredRows.length}
          rowsPerPage={rowsPerPage}
          onPageChange={setPage}
          testId="admin-users-pager"
        />
      </div>

      {/* User detail modal */}
      <UserDetailModal
        detailUserId={detailUserId}
        rows={rows}
        roles={roles}
        detailEditing={detailEditing}
        detailDraft={detailDraft}
        setDetailDraft={setDetailDraft}
        setDetailEditing={setDetailEditing}
        detailError={detailError}
        setDetailError={setDetailError}
        teamOptions={teamOptions}
        canEditUsers={canEditUsers}
        closeDetail={closeDetail}
        updateUserMutation={updateUserMutation}
        tr={tr}
      />

      {/* Pending approval modal */}
      {pendingModalOpen && (
        <ModalOverlay onClose={() => setPendingModalOpen(false)}>
          <div
            className="w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            data-testid="admin-users-pending-window"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/20">
                <Clock className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-ink">
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
                    <thead className="bg-slate-800 text-slate-400">
                      <tr className="text-left text-slate-300">
                        <th className="px-3 py-2.5 w-10">
                          <input
                            type="checkbox"
                            checked={allPendingSelected(pendingSelectedIds, pendingIds)}
                            onChange={toggleAllPending}
                            title={tr('adminUsers.bulk.selectAllPages', 'Select all {{count}} pending users, on every page', { count: pendingIds.length })}
                            aria-label={tr('adminUsers.bulk.selectAllPages', 'Select all {{count}} pending users, on every page', { count: pendingIds.length })}
                            data-testid="admin-users-pending-select-all"
                            className="h-4 w-4 rounded-sm border-slate-600 bg-slate-900 text-primary-600 focus:ring-primary-600 focus:ring-offset-0"
                          />
                        </th>
                        <th className="px-3 py-2.5">{tr('adminUsers.table.name', 'Name')}</th>
                        <th className="px-3 py-2.5">{tr('adminUsers.table.email', 'Email')}</th>
                        <th className="px-3 py-2.5">{tr('adminUsers.form.team', 'Team')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingPageRows.map((u) => {
                        const isChecked = pendingSelectedIds.has(u.id)
                        return (
                          <tr
                            key={u.id}
                            className={`border-t border-slate-700 text-slate-200 cursor-pointer hover:bg-slate-800/50 ${isChecked ? 'bg-primary-950/20' : ''}`}
                            onClick={() => togglePendingSelect(u.id)}
                            data-testid="admin-users-pending-row"
                          >
                            <td className="px-3 py-2.5">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => togglePendingSelect(u.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 rounded-sm border-slate-600 bg-slate-900 text-primary-600 focus:ring-primary-600 focus:ring-offset-0"
                              />
                            </td>
                            <td className="px-3 py-2.5">{u.name}</td>
                            <td className="px-3 py-2.5 text-slate-400">{u.email ?? '-'}</td>
                            <td className="px-3 py-2.5 text-slate-500">{u.team ?? '-'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div data-testid="admin-users-pending-pages">{pendingNav}</div>

                {actionError && (
                  <div className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200" role="alert" data-testid="admin-users-bulk-error">
                    {actionError}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3">
                  {pendingSelectedIds.size > 0 && (
                    <span className="text-xs text-slate-400" data-testid="admin-users-pending-chosen">
                      {tr('adminUsers.bulk.selectedEveryPage', '{{count}} selected, on every page', { count: pendingSelectedIds.size })}
                    </span>
                  )}
                  <div className="flex-1" />
                  {/* Approving a pending user sets the GLOBAL account level.
                      Member = approved (access via per-cluster grants); Admin =
                      global superuser. Cluster Read/Write is granted separately. */}
                  <button
                    type="button"
                    onClick={() => handlePendingBulkApprove('Member')}
                    disabled={pendingSelectedIds.size === 0 || bulkUpdateRoleMutation.isPending}
                    className="rounded-lg bg-green-600/80 px-4 py-2 text-xs font-medium text-ink hover:bg-green-600 disabled:opacity-40"
                  >
                    {tr('adminUsers.bulk.approveMember', 'Approve as Member')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePendingBulkApprove('Admin')}
                    disabled={pendingSelectedIds.size === 0 || bulkUpdateRoleMutation.isPending}
                    className="rounded-lg bg-primary-600/80 px-4 py-2 text-xs font-medium text-ink hover:bg-primary-600 disabled:opacity-40"
                  >
                    {tr('adminUsers.bulk.approveAdmin', 'Approve as Admin')}
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
        <ModalOverlay onClose={() => { setBulkUploadModalOpen(false); setBulkUploadResult(null) }}>
          <div
            className="w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-ink">
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
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-ink hover:bg-slate-600"
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
                <code className="text-xs text-slate-400" data-testid="admin-users-bulk-format">{BULK_CSV_HEADER}</code>
              </div>

              {bulkUploadResult && (
                <div className="space-y-2">
                  {bulkUploadResult.created.length > 0 && (
                    <div className="rounded-lg border border-green-800/40 bg-green-950/20 px-4 py-2 text-sm text-green-300">
                      {tr('adminUsers.bulkCreated', '{{count}} users created.', { count: bulkUploadResult.created.length })}
                    </div>
                  )}
                  {bulkUploadResult.failed.length > 0 && (
                    <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-4 py-2 text-sm text-red-300 space-y-1" role="alert" data-testid="admin-users-bulk-create-failed">
                      <div className="font-medium">{bulkCreateSummary(t, bulkUploadResult.total, bulkUploadResult.failed.length)}</div>
                      {bulkFailureRows.map((row, i) => (
                        <div key={i} data-testid="admin-users-bulk-create-failed-row">{row}</div>
                      ))}
                      <div data-testid="admin-users-bulk-create-failed-pages">{bulkFailureNav}</div>
                    </div>
                  )}
                  {bulkUploadResult.error && (
                    <div className="rounded-lg border border-red-800/40 bg-red-950/20 px-4 py-2 text-sm text-red-300" role="alert" data-testid="admin-users-bulk-create-error">
                      {bulkUploadResult.error}
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

      <CreateUserModal
        open={createModalOpen}
        newUser={newUser}
        onChangeNewUser={setNewUser}
        teamOptions={teamOptions}
        roles={roles}
        mutation={createUserMutation}
        onClose={() => {
          setCreateModalOpen(false)
          setNewUser({ name: '', email: '', password: '', role_id: 0, team: '' })
          // an empty form opened later is not refused yet
          createUserMutation.reset()
        }}
        tr={tr}
      />

      {/* Reset password result modal — 1회용 평문 비밀번호 표시 */}
      {resetResult && (
        <ModalOverlay onClose={closeResetResult}>
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            data-testid="reset-password-result"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-700/60 border border-slate-600">
                <KeyRound className="h-5 w-5 text-slate-300" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-ink">
                  {tr('adminUsers.resetResult.title', 'Password reset')}
                </h2>
                <p className="text-xs text-slate-400">
                  {tr('adminUsers.resetResult.target', 'Target: {{target}}', { target: resetResult.targetLabel })}
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-400 mb-2">
              {tr(
                'adminUsers.resetResult.warning',
                'Copy this temporary password now — it will not be shown again. Ask the user to change it after signing in.',
              )}
            </p>
            {resetResult.self && (
              <p className="text-xs text-amber-300 mb-2" data-testid="reset-password-self">
                {tr('adminUsers.resetResult.self', 'This is your own account: closing this window signs you out. Sign in again with this password.')}
              </p>
            )}

            <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <code className="flex-1 font-mono text-sm text-amber-300 break-all" data-testid="reset-password-value">
                {resetResult.password}
              </code>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyText(resetResult.password)
                  setResetCopyFailed(!ok)
                  if (!ok) return
                  // Copied stays on the button while the window shows this password
                  setResetCopied(true)
                }}
                className="inline-flex items-center gap-1 rounded-sm border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
              >
                <Copy className="h-3.5 w-3.5" />
                {resetCopied
                  ? tr('adminUsers.resetResult.copied', 'Copied')
                  : tr('adminUsers.resetResult.copy', 'Copy')}
              </button>
            </div>
            {resetCopyFailed && (
              <p role="alert" data-testid="reset-password-copy-failed" className="mt-2 text-xs text-red-400">
                {tr('common.copyFailed', 'Not copied: the browser did not take it. Select the text and copy it yourself.')}
              </p>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={closeResetResult}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500"
                data-testid="reset-password-done"
              >
                {resetResult.self
                  ? tr('adminUsers.resetResult.signIn', 'Done — sign in again')
                  : tr('adminUsers.resetResult.close', 'Done')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      <ReauthModal open={reauthModalOpen} tr={tr} />
    </div>
  )
}
