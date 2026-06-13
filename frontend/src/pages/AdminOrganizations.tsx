import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member, Organization } from '@/services/api'
import { Plus, Trash2, Users, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from '@/components/ModalOverlay'
import { usePermission } from '@/hooks/usePermission'

export default function AdminOrganizations() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [newTeam, setNewTeam] = useState('')
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null)

  const { has: hasPerm } = usePermission()
  const canListUsers = hasPerm('admin.users.read')

  const { data: teams = [] } = useQuery({
    queryKey: ['organizations', 'team'],
    queryFn: () => api.listOrganizations('team'),
  })

  const { data: allUsers = [] } = useQuery<Member[]>({
    queryKey: ['admin-users', 'all'],
    queryFn: () => api.adminListUsers({ limit: 200, offset: 0 }),
    enabled: canListUsers,
    staleTime: 10000,
  })

  const orgMembers = selectedOrg
    ? allUsers.filter((u) => u.team === selectedOrg.name)
    : []

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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mt-1 text-sm text-slate-400">{subtitle}</p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const name = inputValue.trim()
          if (!name) return
          createMutation.mutate({ type, name })
        }}
      >
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
          placeholder={tr('adminOrg.inputPlaceholder', 'Enter name...')}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || createMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {tr('adminOrg.add', 'Add')}
        </button>
      </form>

      {createMutation.isError && createMutation.variables?.type === type && (
        <div className="mt-2 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {tr('adminOrg.addError', 'Failed to add. It may already exist.')}
        </div>
      )}

      <div className="mt-4 space-y-1">
        {items.length === 0 && (
          <p className="text-sm text-slate-500 py-2">{tr('adminOrg.empty', 'No items registered.')}</p>
        )}
        {items.map((item) => {
          const memberCount = canListUsers
            ? allUsers.filter((u) => u.team === item.name).length
            : null
          return (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-900/30 px-4 py-2.5 hover:bg-slate-900/60 transition-colors"
            >
              <button
                type="button"
                onClick={() => setSelectedOrg(item)}
                disabled={!canListUsers}
                className="flex-1 flex items-center gap-2 text-left text-sm text-slate-200 hover:text-primary-300 disabled:cursor-default disabled:hover:text-slate-200"
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
              <button
                type="button"
                onClick={() => {
                  const ok = window.confirm(tr('adminOrg.deleteConfirm', 'Delete "{{name}}"?', { name: item.name }))
                  if (!ok) return
                  deleteMutation.mutate({ id: item.id, type: item.type })
                }}
                disabled={deleteMutation.isPending && deleteMutation.variables?.id === item.id}
                className="rounded p-1 text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
                title={tr('adminOrg.deleteTitle', 'Delete')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">{tr('adminOrg.title', 'Team management')}</h1>
        <p className="mt-2 text-slate-400">
          {tr('adminOrg.subtitle', 'Manage the list of Teams that users can select during registration.')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {renderSection(
          tr('adminOrg.teamTitle', 'Team'),
          tr('adminOrg.teamSubtitle', 'Teams / Groups'),
          teams,
          'team',
          newTeam,
          setNewTeam,
        )}
      </div>

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
                  <h2 className="text-lg font-semibold text-white">{selectedOrg.name}</h2>
                  <p className="text-sm text-slate-400">
                    {tr('adminOrg.teamMembers', 'Team members')}
                    <span className="ml-2 text-slate-500">({orgMembers.length})</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrg(null)}
                className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-slate-800"
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
                  <thead className="bg-slate-800 sticky top-0">
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
                          <span className="inline-block rounded bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-300">
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
