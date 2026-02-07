import { Navigate, useLocation } from 'react-router-dom'
import { isLoggedIn } from '@/services/auth'

export default function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation()
  if (!isLoggedIn()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}

