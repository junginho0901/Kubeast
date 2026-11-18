import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { sessionReadSaysSignedOut } from '@/services/auth'

// Leaves for the sign-in page, the cache emptied first, once the server answered the session read (/auth/me) with its
// 401. A read it could not answer (a 503 while the database restarts, no answer) keeps the page.
export function useSignInOnSessionEnd(isError: boolean, error: unknown): void {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const signIn = isError && sessionReadSaysSignedOut(error)
  useEffect(() => {
    if (!signIn) return
    queryClient.clear()
    navigate('/login')
  }, [signIn, navigate, queryClient])
}
