import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { startSessionKeepalive } from '@/services/auth'

// The session is an HttpOnly cookie the page cannot inspect, so "signed in"
// means GET /auth/me succeeds. The result is shared (query key 'me') with the
// layout and the permission hooks.
export default function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation()
  const { data: me, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })

  const ttl = me?.token_ttl_minutes ?? 0
  useEffect(() => {
    if (ttl <= 0) return
    return startSessionKeepalive(ttl)
  }, [ttl])

  if (isError) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  if (isLoading || !me) {
    return <div className="min-h-screen bg-slate-900" />
  }
  return children
}
