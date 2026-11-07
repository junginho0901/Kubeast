import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { SessionDetail } from '@/services/api/types'

// Reads the page of messages above the oldest one a chat list holds, and keeps the reader's place: the list grows above
// the view, so the distance from the bottom is what stays. An answer for a conversation since left is dropped.
export function useEarlierMessages({ sessionId, oldestId, listRef, content, onPage }: {
  sessionId: string | null
  oldestId: number | undefined
  listRef: RefObject<HTMLElement | null>
  content: DependencyList
  onPage: (page: SessionDetail['messages']) => void
}) {
  const current = useRef(sessionId)
  const fromBottom = useRef<number | null>(null)
  const read = useMutation({
    mutationFn: ({ session, before }: { session: string; before: number }) => api.getEarlierMessages(session, before),
    onSuccess: (page, { session }) => {
      if (session !== current.current) return
      const el = listRef.current
      fromBottom.current = el ? el.scrollHeight - el.scrollTop : null
      onPage(page)
    },
  })
  const { reset } = read
  useEffect(() => {
    current.current = sessionId
    reset()
  }, [sessionId, reset])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current
    fromBottom.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, content)

  const failure = read.error as { response?: { data?: { detail?: string } }; message?: string } | null
  return {
    load: () => {
      if (sessionId && oldestId !== undefined) read.mutate({ session: sessionId, before: oldestId })
    },
    loading: read.isPending,
    error: failure ? failure.response?.data?.detail || failure.message || null : null,
  }
}
