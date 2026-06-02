import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { ChatStreamState } from '@/services/chatStreamManager'
import type { Message } from '../types'

// 핵심 sessionDetail sync — 100줄짜리 useEffect 의 단일 담당. AIChat 의 가장
// 미묘한 동작 (DB 동기화가 streaming 중 UI 를 덮어쓰지 않게 방어) 을 담는다.
//
// 사용자가 직접 부딪힌 회귀들:
// 1) 같은 세션을 두 번 클릭하면 빈 welcome 화면 — selectedSessionId 같은 값 set
//    은 useQuery 재실행 안 시키고 setMessages([]) 만 실행되어 영원히 빈 화면.
// 2) Stop 직후 DB 가 잠시 user 만 가지고 있는 상태에서 react-query refetch 가
//    UI 의 assistant 말풍선을 덮어쓰는 회귀.
// 3) 신규 session 생성 직후 DB 가 빈 배열을 줄 때 화면이 "초기화" 깜빡임.
//
// 이 hook 은 이 모든 분기를 보존한다. 변경 시 e2e "clicking same session twice"
// 와 "Korean greeting" 테스트가 회귀 안전망.

interface Params {
  selectedSessionId: string | null
  stoppedSessionId: string | null
  pendingFinalSyncSessionId: string | null
  lastLoadedSessionId: string | null
  setLastLoadedSessionId: (id: string | null) => void
  setPendingFinalSyncSessionId: (id: string | null) => void
  setViewSessionId: (id: string | null) => void
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  streamStateRef: React.MutableRefObject<ChatStreamState>
  messagesRef: React.MutableRefObject<Message[]>
}

interface Result {
  sessionDetail: any
}

const isTempSessionId = (id: string | null) => typeof id === 'string' && id.startsWith('temp:')

export function useSessionDetailSync({
  selectedSessionId,
  stoppedSessionId,
  pendingFinalSyncSessionId,
  lastLoadedSessionId,
  setLastLoadedSessionId,
  setPendingFinalSyncSessionId,
  setViewSessionId,
  setMessages,
  streamStateRef,
  messagesRef,
}: Params): Result {
  const queryClient = useQueryClient()
  const finalSyncRetryRef = useRef<{ sessionId: string | null; tries: number }>({
    sessionId: null,
    tries: 0,
  })
  const finalSyncTimerRef = useRef<number | null>(null)

  const { data: sessionDetail } = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => api.getSession(selectedSessionId!),
    enabled: !!selectedSessionId && !isTempSessionId(selectedSessionId),
  })

  // 세션 상세가 로드되면 메시지 설정
  // - 새 세션으로 전환될 때는 DB 내용을 그대로 사용
  // - 동일 세션에서 스트리밍이 끝난 후에는, 이미 화면에 있는 답변을 덮어쓰지 않도록 함
  useEffect(() => {
    if (sessionDetail && stoppedSessionId !== sessionDetail.id) {
      console.log('[DEBUG] Loading messages from DB:', sessionDetail.messages.length, 'messages')

      const dbMessages = sessionDetail.messages.map((msg: any) => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        toolCalls: msg.tool_calls || undefined,
      }))

      // 스트리밍 직후(DB에 assistant가 아직 저장되기 전)에는 DB가 뒤처진 상태로 UI를 덮어쓰지 않도록 방어
      const uiSnapshot = messagesRef.current
      const uiHasAssistant = uiSnapshot.some((m: Message) => m.role === 'assistant' && (m.content?.length ?? 0) > 0)
      const dbIsBehind = dbMessages.length < uiSnapshot.length
      const activeStream = streamStateRef.current
      const streamRelatedToThisSession =
        activeStream.sessionId === sessionDetail.id && (activeStream.status === 'streaming' || activeStream.status === 'completed')

      // 1) 세션이 바뀐 경우: DB 데이터로 완전히 교체 (스트리밍 중인 세션이라도 화면 세션은 맞춰야 함)
      if (sessionDetail.id !== lastLoadedSessionId) {
        const uiHasTemporary = messagesRef.current.some((m: Message) => m.isTemporary)
        const streamForThisSession =
          activeStream.sessionId === sessionDetail.id && activeStream.status === 'streaming'

        // 새로 만든 세션으로 전환 직후(session 생성 완료 직후)에는 DB가 잠깐 빈 배열을 줄 수 있음.
        // 이때 UI에 이미 임시 말풍선이 있으면, 빈 DB 데이터로 덮어써서 "초기화면으로 깜빡"하지 않게 한다.
        if (dbMessages.length === 0 && (streamForThisSession || uiHasTemporary)) {
          setLastLoadedSessionId(sessionDetail.id)
          setViewSessionId(sessionDetail.id)
          return
        }

        // DB가 뒤처진 상태(assistant 저장 전)라면, UI에 이미 그려진 말풍선을 유지한다.
        if (streamRelatedToThisSession && uiHasAssistant && dbIsBehind) {
          setLastLoadedSessionId(sessionDetail.id)
          setViewSessionId(sessionDetail.id)
          return
        }

        console.log('[DEBUG] Session changed, replacing messages from DB')
        setMessages(dbMessages)
        setLastLoadedSessionId(sessionDetail.id)
        setViewSessionId(sessionDetail.id)
        return
      }

      // 현재 세션이 스트리밍 중이라면 DB의 중간 상태(user만 저장 등)로 UI를 덮어쓰지 않는다.
      if (activeStream.status === 'streaming' && activeStream.sessionId === sessionDetail.id) {
        return
      }

      // 스트리밍 완료 후: DB에 최종 assistant 메시지가 저장되었을 때만 동기화한다.
      if (pendingFinalSyncSessionId && sessionDetail.id === pendingFinalSyncSessionId) {
        const uiLen = messagesRef.current.length
        const last = dbMessages[dbMessages.length - 1]
        // "assistant로 끝난다"만으로는 부족함(이전 턴까지만 있어도 assistant로 끝날 수 있음).
        // 최소한 UI가 가진 메시지 수만큼 DB에 반영된 이후에만 동기화한다.
        if (last && last.role === 'assistant' && dbMessages.length >= uiLen) {
          setMessages(dbMessages)
          setLastLoadedSessionId(sessionDetail.id)
          setPendingFinalSyncSessionId(null)
          setViewSessionId(sessionDetail.id)
          return
        }

        // 아직 DB에 최종 assistant가 반영되지 않았으면 짧게 재조회(몇 번만)해서 동기화 기회를 만든다.
        if (finalSyncRetryRef.current.sessionId !== pendingFinalSyncSessionId) {
          finalSyncRetryRef.current = { sessionId: pendingFinalSyncSessionId, tries: 0 }
        }
        if (finalSyncTimerRef.current != null) {
          clearTimeout(finalSyncTimerRef.current)
          finalSyncTimerRef.current = null
        }
        if (finalSyncRetryRef.current.tries < 8) {
          finalSyncRetryRef.current.tries += 1
          finalSyncTimerRef.current = window.setTimeout(() => {
            void queryClient.refetchQueries({ queryKey: ['session', pendingFinalSyncSessionId] })
          }, 500)
        }
      }

      // 2) 같은 세션인 경우:
      //    - 아직 화면에 영구 메시지가 없으면(DB 초기 로드 등) DB로 교체
      //    - 이미 user/assistant 메시지가 있으면 그대로 유지 (스트리밍 완료 후 덮어쓰지 않음)
      setMessages((prev) => {
        // DB가 뒤처진 상태면(예: assistant 저장 전) 현재 UI를 유지한다.
        if (uiHasAssistant && dbMessages.length < prev.length) {
          return prev
        }
        const hasNonTemporary = prev.some((msg: Message) => !msg.isTemporary)
        if (!hasNonTemporary) {
          console.log('[DEBUG] No non-temporary messages yet, syncing from DB')
          setViewSessionId(sessionDetail.id)
          return dbMessages
        }
        console.log('[DEBUG] Keeping existing messages (same session, non-temporary present)')
        return prev
      })
    }
  }, [pendingFinalSyncSessionId, sessionDetail, stoppedSessionId, lastLoadedSessionId, queryClient,
      setLastLoadedSessionId, setPendingFinalSyncSessionId, setViewSessionId, setMessages,
      streamStateRef, messagesRef])

  // 컴포넌트 언마운트 시 final sync 타이머 정리
  useEffect(() => {
    return () => {
      if (finalSyncTimerRef.current != null) {
        clearTimeout(finalSyncTimerRef.current)
        finalSyncTimerRef.current = null
      }
    }
  }, [])

  return { sessionDetail }
}
