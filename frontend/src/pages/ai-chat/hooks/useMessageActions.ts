import { useCallback, useState } from 'react'
import type { TFunction } from 'i18next'
import { stripToolDetails } from '@/services/chatTextUtils'
import { copyText } from '@/utils/clipboard'
import { exportToolCallsAsZip } from '../exportToolCalls'
import type { Message } from '../types'

// 메시지 단위 액션: 복사 / 결과 zip 다운로드. 복사 1.5s 시각 피드백 (copiedMessageKey).

interface Params {
  viewSessionId: string | null
  selectedSessionId: string | null
  messagesRef: React.MutableRefObject<Message[]>
  t: TFunction
}

interface Result {
  copiedMessageKey: string | null
  handleCopyMessage: (message: Message, key: string) => Promise<void>
  handleDownloadJson: (message: Message) => Promise<void>
}

export function useMessageActions({
  viewSessionId,
  selectedSessionId,
  messagesRef,
  t,
}: Params): Result {
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)

  // the same functions from draw to draw, or every bubble would be drawn again for each letter of an answer
  const handleCopyMessage = useCallback(async (message: Message, key: string) => {
    // the bubble's check only after the copy went through
    if (!(await copyText(stripToolDetails(message.content || '')))) return
    setCopiedMessageKey(key)
    setTimeout(() => {
      setCopiedMessageKey((curr) => (curr === key ? null : curr))
    }, 1500)
  }, [])

  const handleDownloadJson = useCallback(async (message: Message) => {
    const sessionId = viewSessionId || selectedSessionId
    await exportToolCallsAsZip({
      message,
      sessionId,
      t,
      getCurrentMessages: () => messagesRef.current,
    })
  }, [viewSessionId, selectedSessionId, messagesRef, t])

  return { copiedMessageKey, handleCopyMessage, handleDownloadJson }
}
