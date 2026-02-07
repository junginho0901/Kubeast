import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { isLoggedIn } from '@/services/auth'

export default function RequireAdmin({ children }: { children: JSX.Element }) {
  const location = useLocation()

  const { data: me, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: isLoggedIn(),
    retry: false,
    staleTime: 30000,
  })

  if (!isLoggedIn() || isError) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (isLoading) {
    return <div className="min-h-screen bg-slate-900" />
  }

  if (me?.role !== 'admin') {
    return <Navigate to="/" replace />
  }

  return children
}

