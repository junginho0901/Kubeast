import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { isLoggedIn } from '@/services/auth'
import { usePermission } from '@/hooks/usePermission'

interface Props {
  permission: string
  children: JSX.Element
}

export default function RequirePermission({ permission, children }: Props) {
  const location = useLocation()
  const { has } = usePermission()

  const { isLoading, isError } = useQuery({
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

  if (!has(permission)) {
    return <Navigate to="/" replace />
  }

  return children
}
