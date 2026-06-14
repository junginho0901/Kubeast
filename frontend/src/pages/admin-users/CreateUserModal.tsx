// 사용자 생성 모달. AdminUsers.tsx 에서 추출 (Phase 3.4.c).
//
// 부모는 open / form state (newUser + setter) / option lists / mutation /
// onClose 만 전달. mutation 은 ai_service 의 useResourceDelete 패턴처럼
// hook 으로 더 캡슐화 가능하나 현재 useUserCRUD 패턴 X 라 props 로 직접.

import type { UseMutationResult } from '@tanstack/react-query'
import type { RoleWithDetails } from '@/services/api'
import { ModalOverlay } from '@/components/ModalOverlay'
import CustomDropdown from '@/components/CustomDropdown'

interface NewUser {
  name: string
  email: string
  password: string
  role_id: number
  team: string
}

interface OrgOption {
  name: string
}

interface Props {
  open: boolean
  newUser: NewUser
  onChangeNewUser: (updater: (prev: NewUser) => NewUser) => void
  teamOptions: OrgOption[]
  roles: RoleWithDetails[]
  mutation: UseMutationResult<any, any, void>
  onClose: () => void
  tr: (key: string, fallback: string, opts?: any) => string
}

export function CreateUserModal({
  open,
  newUser,
  onChangeNewUser,
  teamOptions,
  roles,
  mutation,
  onClose,
  tr,
}: Props) {
  if (!open) return null
  return (
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
            mutation.mutate()
          }}
        >
          <div>
            <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.name', 'Name')}</label>
            <input
              value={newUser.name}
              onChange={(e) => onChangeNewUser((p) => ({ ...p, name: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
              placeholder={tr('adminUsers.form.namePlaceholder', 'Jane Doe')}
              autoFocus
            />
          </div>

          <CustomDropdown
            label={tr('adminUsers.form.team', 'Team')}
            placeholder={tr('adminUsers.form.selectTeam', 'Select Team')}
            options={teamOptions.map((o) => ({ value: o.name, label: o.name }))}
            value={newUser.team}
            onChange={(v) => onChangeNewUser((p) => ({ ...p, team: v }))}
          />

          <div>
            <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.email', 'Email')}</label>
            <input
              value={newUser.email}
              onChange={(e) => onChangeNewUser((p) => ({ ...p, email: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
              placeholder="user@example.com"
              type="email"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.password', 'Password')}</label>
            <input
              value={newUser.password}
              onChange={(e) => onChangeNewUser((p) => ({ ...p, password: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
              placeholder={tr('adminUsers.form.passwordPlaceholder', 'Initial password')}
              type="password"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">{tr('adminUsers.form.role', 'Role')}</label>
            <select
              value={newUser.role_id}
              onChange={(e) => onChangeNewUser((p) => ({ ...p, role_id: Number(e.target.value) }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-600"
            >
              <option value={0}>{tr('adminUsers.form.selectRole', 'Select role')}</option>
              {/* Global role = account level only. Admin (global superuser) or
                  Member (access via per-cluster grants). Read/Write are granted
                  per-cluster, not globally. */}
              {roles.filter((r) => r.name === 'Admin' || r.name === 'Member').map((r) => (
                <option key={r.id} value={r.id}>{r.name.toUpperCase()}</option>
              ))}
            </select>
          </div>

          {mutation.isError && (
            <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
              {tr('adminUsers.createUserError', 'Failed to create user.')}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              {tr('adminUsers.form.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !newUser.name || !newUser.email || !newUser.password || !newUser.role_id}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:opacity-50"
            >
              {mutation.isPending
                ? tr('adminUsers.form.creating', 'Creating...')
                : tr('adminUsers.form.create', 'Create')}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  )
}
