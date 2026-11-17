import { useEffect, type JSX } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { markSignedIn, noteSessionEnded, retrySessionRead, signInAfterSessionRead, startSessionKeepalive } from '@/services/auth'

// The session is an HttpOnly cookie the page cannot inspect, so "signed in"
// means GET /auth/me succeeds. The result is shared (query key 'me') with the
// layout and the permission hooks. A read that failed without the server
// saying the sign-in is over (a 5xx, no answer) is asked again and keeps the
// page as it is.
export default function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation()
  const { data: me, isLoading, isError, error } = useQuery({
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
  const signIn = isError && signInAfterSessionRead(error, me !== undefined)
  useEffect(() => {
    if (signIn) noteSessionEnded()
  }, [signIn])

  if (signIn) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  if (isLoading || !me) {
    return <div className="min-h-screen bg-slate-900" />
  }
  return children
}
