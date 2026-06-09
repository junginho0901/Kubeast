// 세션 목록 데이터 hook — useInfiniteQuery + cache 가공 helpers + sessionsList
// computed. AIChat.tsx 에서 추출 (Phase 3.2.c).
//
// pinnedSessions 는 optimistic UI 용 임시 세션 (서버 목록에 아직 없는) 을
// 잠깐 노출하는 용도라 부모 (AIChat) 가 관리 + 이 hook 에 prop 으로 전달.
// hook 은 server cache + pinned 합친 결과 (sessionsList) 를 계산.

import { useMemo } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'

import { api } from '@/services/api'
import type { Session } from '@/services/api'
import { useCluster } from '@/contexts/ClusterContext'

import { isTempSessionId } from './utils'

const SESSIONS_PAGE_SIZE = 50

type SessionsPageParam = {
  before_updated_at?: string
  before_id?: string
}

interface Args {
  pinnedSessions: Record<string, Session>
}

export function useChatSessions({ pinnedSessions }: Args) {
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()

  const {
    data: sessionsInfinite,
    isLoading: sessionsLoading,
    isFetchingNextPage: sessionsFetchingNextPage,
    fetchNextPage: fetchNextSessionsPage,
    hasNextPage: sessionsHasNextPage,
  } = useInfiniteQuery({
    // Per-cluster (step 13): switching clusters shows that cluster's sessions.
    // axios injects ?cluster=; the 'sessions' prefix still matches invalidations.
    queryKey: ['sessions', currentCluster],
    queryFn: ({ pageParam }) => api.getSessions({ limit: SESSIONS_PAGE_SIZE, ...(pageParam || {}) }),
    initialPageParam: {} as SessionsPageParam,
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage)) return undefined
      if (lastPage.length < SESSIONS_PAGE_SIZE) return undefined
      const last = lastPage[lastPage.length - 1]
      if (!last) return undefined
      return { before_updated_at: last.updated_at, before_id: last.id } as SessionsPageParam
    },
  })

  const getFlattenedSessions = (data?: InfiniteData<Session[]>) => {
    const pages = data?.pages
    if (!pages || !Array.isArray(pages)) return []
    const seen = new Set<string>()
    const result: Session[] = []
    for (const page of pages) {
      if (!Array.isArray(page)) continue
      for (const session of page) {
        if (!session) continue
        if (seen.has(session.id)) continue
        seen.add(session.id)
        result.push(session)
      }
    }
    return result
  }

  const buildSessionsInfiniteData = (sessions: Session[]): InfiniteData<Session[]> => {
    const pages: Session[][] = []
    for (let i = 0; i < sessions.length; i += SESSIONS_PAGE_SIZE) {
      pages.push(sessions.slice(i, i + SESSIONS_PAGE_SIZE))
    }

    const pageParams: Array<SessionsPageParam | undefined> = []
    let cursor: SessionsPageParam | undefined = {} as SessionsPageParam
    for (const page of pages) {
      pageParams.push(cursor)
      if (page.length > 0) {
        const last = page[page.length - 1]
        cursor = last ? { before_updated_at: last.updated_at, before_id: last.id } : cursor
      }
    }

    return {
      pages: pages.length > 0 ? pages : [[]],
      pageParams,
    }
  }

  const upsertSessionAtFront = (session: Session, optimisticId?: string | null) => {
    queryClient.setQueryData<InfiniteData<Session[]>>(['sessions'], (old) => {
      const existing = getFlattenedSessions(old)
      const withoutDuplicates = existing.filter((s) => s.id !== session.id && (!optimisticId || s.id !== optimisticId))
      return buildSessionsInfiniteData([session, ...withoutDuplicates])
    })
  }

  const sessionsList = useMemo(() => {
    const base = getFlattenedSessions(sessionsInfinite)
    const baseById = new Map(base.map((s) => [s.id, s] as const))
    // pinnedSessions는 "temp:" 세션 등 서버 목록에 아직 없는 항목을 잠깐 노출하기 위한 용도.
    // 서버에서 동일 ID가 내려오면(=실제 세션이 존재) 서버 데이터를 우선한다.
    const pinnedVisible = Object.values(pinnedSessions).filter((s) => isTempSessionId(s.id) || !baseById.has(s.id))
    const pinnedIds = new Set(pinnedVisible.map((s) => s.id))
    return [...pinnedVisible, ...base.filter((s) => !pinnedIds.has(s.id))]
  }, [pinnedSessions, sessionsInfinite])

  return {
    sessionsList,
    sessionsLoading,
    sessionsFetchingNextPage,
    fetchNextSessionsPage,
    sessionsHasNextPage,
    upsertSessionAtFront,
  }
}
