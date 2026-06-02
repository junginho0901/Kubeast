import { useState } from 'react'
import type { TFunction } from 'i18next'
import { stripToolDetails } from '@/services/chatTextUtils'
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

  const handleCopyMessage = async (message: Message, key: string) => {
    try {
      await navigator.clipboard.writeText(stripToolDetails(message.content || ''))
      setCopiedMessageKey(key)
      setTimeout(() => {
        setCopiedMessageKey((curr) => (curr === key ? null : curr))
      }, 1500)
    } catch (err) {
      console.warn('[AIChat] copy failed', err)
    }
  }

  const handleDownloadJson = async (message: Message) => {
    const sessionId = viewSessionId || selectedSessionId
    await exportToolCallsAsZip({
      message,
      sessionId,
      t,
      getCurrentMessages: () => messagesRef.current,
    })
  }

  return { copiedMessageKey, handleCopyMessage, handleDownloadJson }
}
