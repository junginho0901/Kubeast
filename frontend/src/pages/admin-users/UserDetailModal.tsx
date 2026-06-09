// 사용자 상세 모달 (조회 + 편집). AdminUsers.tsx 에서 추출 (Phase 3.4.c).
//
// 부모는 detailUserId / rows / roles / 편집 state / mutation / hq+team options
// / canEditUsers / tr 모두 prop 으로 전달. props 가 많은 이유는 부모가 모든
// state 와 mutation 을 보유하기 때문 — useUserCRUD 같은 hook 으로 묶기엔
// 외부 setter 의존이 12+개라 ROI 낮아 그대로 둠.

import type { UseMutationResult } from '@tanstack/react-query'
import type { Member, RoleWithDetails } from '@/services/api'
import ClusterRoleMatrix from '@/pages/admin/ClusterRoleMatrix'
import { Pencil, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import CustomDropdown from '@/components/CustomDropdown'

interface DetailDraft {
  name: string
  hq: string
  team: string
  role_id: number
}

interface OrgOption {
  name: string
}

interface Props {
  detailUserId: string | null
  rows: Member[]
  roles: RoleWithDetails[]
  detailEditing: boolean
  detailDraft: DetailDraft
  setDetailDraft: React.Dispatch<React.SetStateAction<DetailDraft>>
  setDetailEditing: (v: boolean) => void
  detailError: string | null
  setDetailError: (v: string | null) => void
  hqOptions: OrgOption[]
  teamOptions: OrgOption[]
  canEditUsers: boolean
  closeDetail: () => void
  updateUserMutation: UseMutationResult<any, any, { userId: string; payload: any }>
  tr: (key: string, fallback: string, opts?: any) => string
}

export function UserDetailModal({
  detailUserId,
  rows,
  roles,
  detailEditing,
  detailDraft,
  setDetailDraft,
  setDetailEditing,
  detailError,
  setDetailError,
  hqOptions,
  teamOptions,
  canEditUsers,
  closeDetail,
  updateUserMutation,
  tr,
}: Props) {
  if (!detailUserId) return null
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
                <CustomDropdown
                  placeholder={tr('adminUsers.form.selectHq', 'Select HQ')}
                  options={hqOptions.map((o) => ({ value: o.name, label: o.name }))}
                  value={detailDraft.hq}
                  onChange={(v) => setDetailDraft((p) => ({ ...p, hq: v }))}
                />
              ) : (
                <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 px-3 py-2 text-sm text-slate-200">{u.hq || '-'}</div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                {tr('adminUsers.form.team', 'Team')}
              </label>
              {detailEditing ? (
                <CustomDropdown
                  placeholder={tr('adminUsers.form.selectTeam', 'Select Team')}
                  options={teamOptions.map((o) => ({ value: o.name, label: o.name }))}
                  value={detailDraft.team}
                  onChange={(v) => setDetailDraft((p) => ({ ...p, team: v }))}
                />
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

          <ClusterRoleMatrix
            userID={u.id}
            canEdit={canEditUsers}
            userIsGlobalAdmin={permissions.some((p) => p === '*' || p.startsWith('admin.'))}
          />
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
}
