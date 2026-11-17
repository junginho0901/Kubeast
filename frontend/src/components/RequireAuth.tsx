import { useEffect, type JSX } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { markSignedIn, noteSessionEnded, retrySessionRead, sessionReadSaysSignedOut, startSessionKeepalive } from '@/services/auth'
import { failureText } from '@/utils/failureText'

// The session is an HttpOnly cookie the page cannot inspect, so "signed in"
// means GET /auth/me succeeds. The result is shared (query key 'me') with the
// layout and the permission hooks. Only the server's 401 sends the page to
// sign in; a read that failed otherwise (a 503 while the database restarts, no
// answer) is asked again and keeps the page as it is, or, before any answer,
// says that it is asking again.
export default function RequireAuth({ children }: { children: JSX.Element }) {
  const { t } = useTranslation()
  const location = useLocation()
  const { data: me, isError, error, failureCount, failureReason } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: retrySessionRead,
    staleTime: 30000,
  })

  const ttl = me?.token_ttl_minutes ?? 0
  useEffect(() => {
    if (ttl <= 0) return
    return startSessionKeepalive(ttl)
  }, [ttl])

  // the sign-in page says the session ended when a browser that was signed in comes back without one
  const meId = me?.id
  useEffect(() => {
    if (meId) markSignedIn()
  }, [meId])
  const signIn = isError && sessionReadSaysSignedOut(error)
  useEffect(() => {
    if (signIn) noteSessionEnded()
  }, [signIn])

  if (signIn) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  if (!me) {
    if (failureCount > 0 && failureReason) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4 text-sm text-slate-400" role="status" data-testid="session-check-waiting">
          {t('liveSession.checking', {
            defaultValue: 'Could not check your sign-in: {{reason}}. Asking again…',
            reason: failureText(failureReason),
          })}
        </div>
      )
    }
    return <div className="min-h-screen bg-slate-900" />
  }
  return children
}
