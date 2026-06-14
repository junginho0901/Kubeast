import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, Member, RoleWithDetails } from '@/services/api'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Shield, X, Check, Users } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { usePermission } from '@/hooks/usePermission'

type PermCategory = { category: string; permissions: Array<{ key: string; description: string }> }

export default function AdminRoles() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...opts })

  const [editingRole, setEditingRole] = useState<RoleWithDetails | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formPerms, setFormPerms] = useState<Set<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const [usersRole, setUsersRole] = useState<RoleWithDetails | null>(null)

  const { has: hasPerm } = usePermission()
  const canListUsers = hasPerm('admin.users.read')

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: api.listRoles,
  })

  const { data: allUsers = [] } = useQuery<Member[]>({
    queryKey: ['admin-users', 'all'],
    queryFn: () => api.adminListUsers({ limit: 200, offset: 0 }),
    enabled: canListUsers,
    staleTime: 10000,
  })

  const roleMembers = usersRole
    ? allUsers.filter((u) => u.role?.id === usersRole.id)
    : []

  const { data: permCatalog = [] } = useQuery<PermCategory[]>({
    queryKey: ['permissions'],
    queryFn: api.listPermissions,
  })

  const createMutation = useMutation({
    mutationFn: (req: { name: string; description: string; permissions: string[] }) => api.adminCreateRole(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      closeModal()
    },
    onError: () => setFormError(tr('adminRoles.createError', 'Failed to create role')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...req }: { id: number; name: string; description: string; permissions: string[] }) =>
      api.adminUpdateRole(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      closeModal()
    },
    onError: () => setFormError(tr('adminRoles.updateError', 'Failed to update role')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.adminDeleteRole(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['roles'] }),
  })

  const closeModal = () => {
    setEditingRole(null)
    setIsCreating(false)
    setFormName('')
    setFormDesc('')
    setFormPerms(new Set())
    setFormError(null)
  }

  const openCreate = () => {
    setIsCreating(true)
    setEditingRole(null)
    setFormName('')
    setFormDesc('')
    setFormPerms(new Set())
    setFormError(null)
  }

  const openEdit = (role: RoleWithDetails) => {
    setEditingRole(role)
    setIsCreating(false)
    setFormName(role.name)
    setFormDesc(role.description)
    setFormPerms(new Set(role.permissions))
    setFormError(null)
  }

  const togglePerm = (key: string) => {
    setFormPerms((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSubmit = () => {
    const name = formName.trim()
    if (!name) {
      setFormError(tr('adminRoles.nameRequired', 'Role name is required'))
      return
    }
    const perms = Array.from(formPerms)
    if (editingRole) {
      updateMutation.mutate({ id: editingRole.id, name, description: formDesc.trim(), permissions: perms })
    } else {
      createMutation.mutate({ name, description: formDesc.trim(), permissions: perms })
    }
  }

  const isModalOpen = isCreating || editingRole !== null
  const isSaving = createMutation.isPending || updateMutation.isPending

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('adminRoles.title', 'Role Management')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('adminRoles.subtitle', 'Create custom roles with fine-grained permissions')}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-500 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {tr('adminRoles.create', 'Create Role')}
        </button>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">{tr('adminRoles.loading', 'Loading...')}</div>
      ) : (
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800">
              <tr className="text-left text-slate-300">
                <th className="px-4 py-3">{tr('adminRoles.col.name', 'Name')}</th>
                <th className="px-4 py-3">{tr('adminRoles.col.description', 'Description')}</th>
                <th className="px-4 py-3">{tr('adminRoles.col.permissions', 'Permissions')}</th>
                <th className="px-4 py-3">{tr('adminRoles.col.type', 'Type')}</th>
                <th className="px-4 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const memberCount = canListUsers
                  ? allUsers.filter((u) => u.role?.id === role.id).length
                  : null
                return (
                <tr key={role.id} className="border-t border-slate-700 text-slate-200">
                  <td className="px-4 py-3 font-medium">
                    <button
                      type="button"
                      onClick={() => setUsersRole(role)}
                      disabled={!canListUsers}
                      className="inline-flex items-center gap-2 text-left hover:text-primary-300 hover:underline disabled:cursor-default disabled:hover:text-slate-200 disabled:hover:no-underline"
                      title={canListUsers ? tr('adminRoles.viewUsers', 'View users with this role') : ''}
                    >
                      <span>{role.name}</span>
                      {memberCount !== null && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-700/50 px-2 py-0.5 text-[10px] font-normal text-slate-400">
                          <Users className="w-3 h-3" />
                          {memberCount}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{role.description || '-'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {role.permissions.slice(0, 5).map((p) => (
                        <span
                          key={p}
                          className="inline-block rounded bg-slate-700/60 px-1.5 py-0.5 text-[11px] text-slate-300"
                        >
                          {p}
                        </span>
                      ))}
                      {role.permissions.length > 5 && (
                        <span className="inline-block rounded bg-slate-700/60 px-1.5 py-0.5 text-[11px] text-slate-400">
                          +{role.permissions.length - 5}
                        </span>
                      )}
                      {role.permissions.length === 0 && (
                        <span className="text-xs text-slate-500">{tr('adminRoles.noPerms', 'No permissions')}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {role.is_system ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-400 border border-blue-500/20">
                        <Shield className="w-2.5 h-2.5" /> System
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Custom</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(role)}
                        className="rounded p-1.5 text-slate-500 hover:text-primary-400 hover:bg-primary-950/30 transition-colors"
                        title={tr('adminRoles.edit', 'Edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {!role.is_system && (
                        <button
                          onClick={() => {
                            if (window.confirm(tr('adminRoles.deleteConfirm', 'Delete "{{name}}"?', { name: role.name })))
                              deleteMutation.mutate(role.id)
                          }}
                          disabled={deleteMutation.isPending}
                          className="rounded p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
                          title={tr('adminRoles.delete', 'Delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Role users modal */}
      {usersRole && (
        <ModalOverlay onClose={() => setUsersRole(null)}>
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
                  <h2 className="text-lg font-semibold text-white">{usersRole.name}</h2>
                  <p className="text-sm text-slate-400">
                    {tr('adminRoles.usersWithRole', 'Users with this global (account-level) role')}
                    <span className="ml-2 text-slate-500">({roleMembers.length})</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {tr(
                      'adminRoles.usersWithRoleNote',
                      'This counts the global role only. Per-cluster access (Read/Write on a cluster) is granted separately in cluster access.',
                    )}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUsersRole(null)}
                className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-700/50">
              {roleMembers.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  {tr('adminRoles.noUsers', 'No users assigned to this role.')}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-800 sticky top-0">
                    <tr className="text-left text-slate-300">
                      <th className="px-3 py-2.5">{tr('adminRoles.col.userName', 'Name')}</th>
                      <th className="px-3 py-2.5">{tr('adminRoles.col.userEmail', 'Email')}</th>
                      <th className="px-3 py-2.5">{tr('adminRoles.col.userTeam', 'Team')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roleMembers.map((u) => (
                      <tr key={u.id} className="border-t border-slate-700 text-slate-200">
                        <td className="px-3 py-2.5">{u.name}</td>
                        <td className="px-3 py-2.5 text-slate-400">{u.email ?? '-'}</td>
                        <td className="px-3 py-2.5 text-slate-500">{u.team ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setUsersRole(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                {tr('adminRoles.closeUsers', 'Close')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Create / Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10 border border-primary-500/20">
                  <Shield className="h-5 w-5 text-primary-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {editingRole
                      ? tr('adminRoles.editTitle', 'Edit Role')
                      : tr('adminRoles.createTitle', 'Create Role')}
                  </h2>
                  <p className="text-sm text-slate-400">
                    {editingRole?.is_system
                      ? tr('adminRoles.systemNote', 'System role: name cannot be changed')
                      : tr('adminRoles.customNote', 'Select permissions for this role')}
                  </p>
                </div>
              </div>
              <button onClick={closeModal} className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-slate-800">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form fields */}
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {tr('adminRoles.form.name', 'Role Name')}
                </label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  disabled={editingRole?.is_system}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600 disabled:opacity-50"
                  placeholder={tr('adminRoles.form.namePh', 'e.g. InfraManager')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {tr('adminRoles.form.desc', 'Description')}
                </label>
                <input
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('adminRoles.form.descPh', 'e.g. Infrastructure team lead')}
                />
              </div>
            </div>

            {/* Permission grid */}
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {permCatalog.map((cat) => (
                <div key={cat.category} className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-4">
                  <h3 className="text-sm font-semibold text-slate-200 mb-3">{cat.category}</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    {cat.permissions.map((p) => (
                      <label
                        key={p.key}
                        className="flex items-center gap-2.5 cursor-pointer group"
                      >
                        <input
                          type="checkbox"
                          checked={formPerms.has(p.key)}
                          onChange={() => togglePerm(p.key)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-primary-600 focus:ring-primary-600 focus:ring-offset-0"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-mono text-slate-300 group-hover:text-white transition-colors">
                            {p.key}
                          </span>
                          <span className="ml-2 text-[11px] text-slate-500">{p.description}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Error */}
            {formError && (
              <div className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                {formError}
              </div>
            )}

            {/* Footer */}
            <div className="mt-5 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                {tr('adminRoles.selectedCount', '{{count}} permissions selected', { count: formPerms.size })}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={closeModal}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/50 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  {tr('adminRoles.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50 transition-colors"
                >
                  <Check className="w-4 h-4" />
                  {isSaving
                    ? tr('adminRoles.saving', 'Saving...')
                    : editingRole
                      ? tr('adminRoles.save', 'Save')
                      : tr('adminRoles.createBtn', 'Create')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
