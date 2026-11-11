import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import type { ExportOutcome } from './exportToolCalls'
import { MessageBubble } from './MessageBubble'
import { useAIChat } from './AIChatContext'
import { dbMessageToMessage } from './hooks/useSessionDetailSync'
import type { SessionDetail } from '@/services/api/types'
import { hiddenEarlier, prependEarlier } from '@/services/sessionMessages'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useEarlierMessages } from '@/hooks/useEarlierMessages'
import EarlierMessages from '@/components/EarlierMessages'
import JumpToLatest from '@/components/JumpToLatest'
import type { CopyResult } from './hooks/useMessageActions'

// 메시지 리스트. 맨 아래에 있을 때만 새 글을 따라가고, 위로 올리면 멈추고 "맨 아래로" 버튼을 보인다.
// 새 질문을 보내면 부드럽게 맨 아래로. 말풍선 key 는 대화 + 순서 — 답이 끝나 서버 목록으로 바뀔 때
// 같은 말풍선이 그대로 남아 버튼 줄이 열리는 애니메이션이 끊기지 않는다.

interface Props {
  sessionDetail?: SessionDetail
  copyResult: CopyResult | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => Promise<ExportOutcome>
  t: TFunction
}

export function MessagesList({ sessionDetail, copyResult, onCopy, onDownloadJson, t }: Props) {
  const { messages, setMessages, messagesEndRef, selectedSessionId } = useAIChat()
  const { ref, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([messages])

  // a bubble's key counts from the first page read, so a page read above it moves no bubble to another key
  const [above, setAbove] = useState(0)
  const earlier = useEarlierMessages({
    sessionId: selectedSessionId,
    oldestId: messages.find((m) => typeof m.id === 'number')?.id,
    listRef: ref,
    content: [messages],
    onPage: (page) => {
      setAbove((n) => n + page.length)
      setMessages((prev) => prependEarlier(prev, page.map(dbMessageToMessage)))
    },
  })

  useEffect(() => {
    scrollToBottom({ instant: true })
  }, [selectedSessionId, scrollToBottom])

  const questions = messages.filter((m) => m.role === 'user').length
  const lastQuestions = useRef(questions)
  useEffect(() => {
    if (questions > lastQuestions.current) scrollToBottom()
    lastQuestions.current = questions
  }, [questions, scrollToBottom])

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={ref} className="flex-1 overflow-y-auto" data-testid="chat-messages">
        <EarlierMessages hidden={hiddenEarlier(sessionDetail, messages)} loading={earlier.loading} error={earlier.error} onLoad={earlier.load} />
        {messages.map((message, idx) => (
          <MessageBubble
            key={`${selectedSessionId ?? 'new'}:${idx - above}`}
            message={message}
            idx={idx}
            copyResult={copyResult}
            onCopy={onCopy}
            onDownloadJson={onDownloadJson}
            t={t}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      {!atBottom && <JumpToLatest onClick={() => scrollToBottom()} />}
    </div>
  )
}
