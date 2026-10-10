// 사용자 생성 모달. AdminUsers.tsx 에서 추출 (Phase 3.4.c).
//
// 부모는 open / form state (newUser + setter) / option lists / mutation /
// onClose 만 전달. mutation 은 ai_service 의 useResourceDelete 패턴처럼
// hook 으로 더 캡슐화 가능하나 현재 useUserCRUD 패턴 X 라 props 로 직접.

import type { UseMutationResult } from '@tanstack/react-query'
import type { RoleWithDetails } from '@/services/api'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
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

const inputClass = 'w-full h-10 rounded-lg border border-slate-700 bg-slate-950/40 px-3 text-sm text-white placeholder:text-slate-500 focus:outline-hidden focus:ring-2 focus:ring-primary-600'

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
  const incomplete = !newUser.name || !newUser.email || !newUser.password || !newUser.role_id
  return (
    <ModalFrame
      size="md"
      title={tr('adminUsers.createUserTitle', 'Add user')}
      subtitle={tr('adminUsers.createUserSubtitle', 'Create a new user account with a specified role.')}
      onClose={onClose}
      busy={mutation.isPending}
      testId="create-user-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} className={modalButton.cancel} disabled={mutation.isPending}>
            {tr('adminUsers.form.cancel', 'Cancel')}
          </button>
          <button type="submit" form="create-user-form" disabled={mutation.isPending || incomplete} className={modalButton.primary}>
            {mutation.isPending
              ? tr('adminUsers.form.creating', 'Creating...')
              : tr('adminUsers.form.create', 'Create')}
          </button>
        </>
      }
    >
      <form
        id="create-user-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (incomplete) return
          mutation.mutate()
        }}
      >
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('adminUsers.form.name', 'Name')}</label>
          <input
            value={newUser.name}
            onChange={(e) => onChangeNewUser((p) => ({ ...p, name: e.target.value }))}
            className={inputClass}
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
          <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('adminUsers.form.email', 'Email')}</label>
          <input
            value={newUser.email}
            onChange={(e) => onChangeNewUser((p) => ({ ...p, email: e.target.value }))}
            className={inputClass}
            placeholder="user@example.com"
            type="email"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('adminUsers.form.password', 'Password')}</label>
          <input
            value={newUser.password}
            onChange={(e) => onChangeNewUser((p) => ({ ...p, password: e.target.value }))}
            className={inputClass}
            placeholder={tr('adminUsers.form.passwordPlaceholder', 'Initial password')}
            type="password"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('adminUsers.form.role', 'Role')}</label>
          {/* Global role = account level only. Admin (global superuser) or
              Member (access via per-cluster grants). Read/Write are granted
              per-cluster, not globally. */}
          <CustomDropdown
            testId="create-user-role"
            value={String(newUser.role_id || 0)}
            onChange={(v) => onChangeNewUser((p) => ({ ...p, role_id: Number(v) }))}
            options={[
              { value: '0', label: tr('adminUsers.form.selectRole', 'Select role') },
              ...roles.filter((r) => r.name === 'Admin' || r.name === 'Member').map((r) => ({ value: String(r.id), label: r.name })),
            ]}
          />
        </div>

        {mutation.isError && (
          <div className="rounded-lg border border-red-900/40 bg-red-950/30 px-3 py-2 text-sm text-red-200">
            {tr('adminUsers.createUserError', 'Failed to create user.')}
          </div>
        )}
      </form>
    </ModalFrame>
  )
}
