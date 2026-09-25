// 권한 변경 후 재로그인 안내 모달. AdminUsers.tsx 에서 추출 (Phase 3.4.c).
//
// 사용자가 자신의 role 을 admin → 다른 권한 으로 바꾸면 즉시 로그아웃 + 로그인
// 페이지 redirect. 부모는 open 여부만 관리.

import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { logoutSession } from '@/services/auth'
import { ModalOverlay } from '@/components/ModalOverlay'

interface Props {
  open: boolean
  tr: (key: string, fallback: string) => string
}

export function ReauthModal({ open, tr }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (!open) return null
  return (
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
              void logoutSession()
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
  )
}
