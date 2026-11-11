import { useCallback, useState } from 'react'
import type { TFunction } from 'i18next'
import { stripToolDetails } from '@/services/chatTextUtils'
import { copyText } from '@/utils/clipboard'
import { exportToolCallsAsZip, type ExportOutcome } from '../exportToolCalls'
import type { Message } from '../types'

// 메시지 단위 액션: 복사 / 결과 zip 다운로드. 복사 결과(copyResult)는 다음 복사까지 그 말풍선에 남는다.

export interface CopyResult {
  key: string
  ok: boolean
}

interface Params {
  viewSessionId: string | null
  selectedSessionId: string | null
  messagesRef: React.MutableRefObject<Message[]>
  t: TFunction
}

interface Result {
  copyResult: CopyResult | null
  handleCopyMessage: (message: Message, key: string) => Promise<void>
  handleDownloadJson: (message: Message) => Promise<ExportOutcome>
}

export function useMessageActions({
  viewSessionId,
  selectedSessionId,
  messagesRef,
  t,
}: Params): Result {
  const [copyResult, setCopyResult] = useState<CopyResult | null>(null)

  // the same functions from draw to draw, or every bubble would be drawn again for each letter of an answer
  const handleCopyMessage = useCallback(async (message: Message, key: string) => {
    // Copied only after the copy went through, Not copied when it did not; either stays until the next copy
    const ok = await copyText(stripToolDetails(message.content || ''))
    setCopyResult({ key, ok })
  }, [])

  const handleDownloadJson = useCallback(async (message: Message) => {
    const sessionId = viewSessionId || selectedSessionId
    return exportToolCallsAsZip({
      message,
      sessionId,
      t,
      getCurrentMessages: () => messagesRef.current,
    })
  }, [viewSessionId, selectedSessionId, messagesRef, t])

  return { copyResult, handleCopyMessage, handleDownloadJson }
}
