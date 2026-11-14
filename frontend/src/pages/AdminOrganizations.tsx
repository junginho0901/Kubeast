import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member, Organization } from '@/services/api'
import { Plus, Search, Trash2, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionFailure } from '@/components/ActionFailure'
import { ModalOverlay } from '@/components/ModalOverlay'
import { ListPager } from '@/components/ListPager'
import { failureText } from '@/utils/failureText'
import { RefreshFailure } from '@/components/RefreshFailure'
import { failureOf } from '@/hooks/useRefresh'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { usePermission } from '@/hooks/usePermission'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { useConfirm } from '@/services/confirm'
import { pageOf } from '@/utils/listPages'
import { NAME_MAX } from '@/utils/nameLimits'
import { teamsMatching } from './admin/adminListSearch'

// Admin → Teams: the teams users pick from, each with its member count. The page is as high as the screen and the
// list pages the teams, as many as fit (or the footer's fixed choice); the search reads every team's name.
const TEAM_COLUMNS = 2

export default function AdminOrganizations() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const confirm = useConfirm()

  const [newTeam, setNewTeam] = useState('')
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null)

  const { has: hasPerm } = usePermission()
  const canListUsers = hasPerm('admin.users.read')

  const { data: teams = [], error: teamsError, errorUpdatedAt: teamsErrorAt, refetch: readTeamsAgain } = useQuery({
    queryKey: ['organizations', 'team'],
    queryFn: () => api.listOrganizations('team'),
  })

  const { data: allUsers = [] } = useQuery<Member[]>({
    queryKey: ['admin-users', 'all'],
    queryFn: api.adminListAllUsers,
    enabled: canListUsers,
    staleTime: 10000,
  })

  const orgMembers = selectedOrg
    ? allUsers.filter((u) => u.team === selectedOrg.name)
    : []

  const [search, setSearch] = useState('')
  const found = useMemo(() => teamsMatching(teams, search), [teams, search])
  const [page, setPage] = useState(1)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: found.length })
  const shown = pageOf(found, page, rowsPerPage)

  const createMutation = useMutation({
    mutationFn: ({ type, name }: { type: 'team'; name: string }) => api.adminCreateOrganization(type, name),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['organizations', vars.type] })
      setNewTeam('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: number; type: string }) => api.adminDeleteOrganization(id),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['organizations', vars.type] })
    },
  })

  const renderSection = (
    title: string,
    subtitle: string,
    items: Organization[],
    type: 'team',
    inputValue: string,
    setInputValue: (v: string) => void,
  ) => (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-col rounded-2xl border border-slate-700 bg-slate-800/50 p-5">
      <h2 className="text-lg font-semibold text-ink shrink-0">{title}</h2>
      <p className="mt-1 text-sm text-slate-400 shrink-0">{subtitle}</p>

      <form
        className="mt-4 flex gap-2 shrink-0"
        onSubmit={(e) => {
          e.preventDefault()
          const name = inputValue.trim()
          if (!name) {
            e.currentTarget.querySelector('input')?.focus()
            return
          }
          createMutation.mutate({ type, name })
        }}
      >
        <input
          value={inputValue}
          maxLength={NAME_MAX}
          onChange={(e) => setInputValue(e.target.value)}
          className="flex-1 h-10 rounded-lg border border-slate-700 bg-slate-950/40 px-3 text-sm text-ink placeholder:text-slate-500 focus:outline-hidden focus:ring-2 focus:ring-primary-600"
          placeholder={tr('adminOrg.inputPlaceholder', 'Enter name...')}
        />
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {tr('adminOrg.add', 'Add')}
        </button>
      </form>

      <div className="relative mt-3 shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          placeholder={tr('adminOrg.searchPlaceholder', 'Search teams by name...')}
          aria-label={tr('adminOrg.searchPlaceholder', 'Search teams by name...')}
          data-testid="teams-search"
          className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
      </div>

      {createMutation.isError && createMutation.variables?.type === type && (
        <div role="alert" data-testid="team-add-error" className="mt-2 shrink-0 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200 break-words">
          {tr('adminOrg.addError', 'Not added: {{reason}}', { reason: failureText(createMutation.error) })}
        </div>
      )}
      {deleteMutation.isError && deleteMutation.variables?.type === type && (
        <ActionFailure error={deleteMutation.error} action="delete" testId="team-delete-error" className="mt-2 shrink-0" />
      )}
      <RefreshFailure failure={items.length ? failureOf(teamsError, teamsErrorAt) : null} className="mt-2" />

      <div ref={bodyRef} className="mt-4 overflow-x-auto flex-1 min-h-0">
        <table className="w-full text-sm" data-testid="teams-table">
          <thead ref={theadRef} className="text-slate-400">
            <tr className="text-left">
              <th className="px-4 py-2.5">{tr('adminOrg.col.name', 'Name')}</th>
              <th className="px-4 py-2.5 w-14" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
        {shown.rows.map((item, idx) => {
          const memberCount = canListUsers
            ? allUsers.filter((u) => u.team === item.name).length
            : null
          return (
            <tr
              key={item.id}
              ref={idx === 0 ? firstRowRef : undefined}
              className="hover:bg-slate-900/60 transition-colors"
            >
              <td className="px-4 py-2.5">
              <button
                type="button"
                onClick={() => setSelectedOrg(item)}
                disabled={!canListUsers}
                className="flex items-center gap-2 text-left text-sm text-slate-200 hover:text-primary-300 disabled:cursor-default disabled:hover:text-slate-200"
                title={canListUsers ? tr('adminOrg.viewMembers', 'View members') : ''}
              >
                <span>{item.name}</span>
                {memberCount !== null && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-700/50 px-2 py-0.5 text-[10px] text-slate-400">
                    <Users className="w-3 h-3" />
                    {memberCount}
                  </span>
                )}
              </button>
              </td>
              <td className="px-4 py-2.5 text-right">
              <button
                type="button"
                onClick={async () => {
                  const ok = await confirm({
                    title: tr('adminOrg.deleteDialogTitle', 'Delete team'),
                    message: tr('adminOrg.deleteConfirm', 'Delete team "{{name}}"?', { name: item.name }),
                    confirmLabel: tr('adminOrg.deleteTitle', 'Delete'),
                    danger: true,
                  })
                  if (!ok) return
                  deleteMutation.mutate({ id: item.id, type: item.type })
                }}
                disabled={deleteMutation.isPending && deleteMutation.variables?.id === item.id}
                className="rounded-sm p-1 text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
                title={tr('adminOrg.deleteTitle', 'Delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              </td>
            </tr>
          )
        })}
            {items.length === 0 && (
              <TableEmptyRow colSpan={TEAM_COLUMNS} resource="admin-teams" className="px-4 py-2 text-left text-sm text-slate-500" error={teamsError} onRetry={() => void readTeamsAgain()}>
                {tr('adminOrg.empty', 'No items registered.')}
              </TableEmptyRow>
            )}
            {items.length > 0 && found.length === 0 && (
              <TableEmptyRow colSpan={TEAM_COLUMNS} resource="admin-teams" searching className="px-4 py-2 text-left text-sm text-slate-500" />
            )}
          </tbody>
          <AdaptiveTableFillerRows count={rowsPerPage - shown.rows.length} columnCount={TEAM_COLUMNS} cellClassName="py-2.5" />
        </table>
      </div>
      <ListPager currentPage={shown.page} totalPages={shown.pages} total={found.length} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="teams-pager" />
    </div>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="shrink-0">
        <h1 className="text-3xl font-semibold text-ink">{tr('adminOrg.title', 'Team management')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('adminOrg.subtitle', 'Manage the list of Teams that users can select during registration.')}
        </p>
      </div>

      {renderSection(
        tr('adminOrg.teamTitle', 'Team'),
        tr('adminOrg.teamSubtitle', 'Teams / Groups'),
        teams,
        'team',
        newTeam,
        setNewTeam,
      )}

      {selectedOrg && (
        <ModalOverlay onClose={() => setSelectedOrg(null)}>
          <div
            className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl max-h-[80vh] flex flex-col"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10 border border-primary-500/20">
                  <Users className="h-5 w-5 text-primary-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-ink">{selectedOrg.name}</h2>
                  <p className="text-sm text-slate-400">
                    {tr('adminOrg.teamMembers', 'Team members')}
                    <span className="ml-2 text-slate-500">({orgMembers.length})</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrg(null)}
                className="rounded-sm p-1.5 text-slate-400 hover:text-ink hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/50">
              {orgMembers.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  {tr('adminOrg.noMembers', 'No members in this organization.')}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-800 sticky top-0 text-slate-400">
                    <tr className="text-left text-slate-300">
                      <th className="px-3 py-2.5">{tr('adminOrg.col.name', 'Name')}</th>
                      <th className="px-3 py-2.5">{tr('adminOrg.col.email', 'Email')}</th>
                      <th className="px-3 py-2.5">{tr('adminOrg.col.role', 'Role')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgMembers.map((u) => (
                      <tr key={u.id} className="border-t border-slate-700 text-slate-200">
                        <td className="px-3 py-2.5">{u.name}</td>
                        <td className="px-3 py-2.5 text-slate-400">{u.email ?? '-'}</td>
                        <td className="px-3 py-2.5">
                          <span className="inline-block rounded-sm bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-300">
                            {u.role?.name ?? '-'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedOrg(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                {tr('adminOrg.close', 'Close')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
