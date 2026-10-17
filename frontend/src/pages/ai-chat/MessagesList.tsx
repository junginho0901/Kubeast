import { useEffect, useRef } from 'react'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import { MessageBubble } from './MessageBubble'
import { useAIChat } from './AIChatContext'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import JumpToLatest from '@/components/JumpToLatest'

// 메시지 리스트. 맨 아래에 있을 때만 새 글을 따라가고, 위로 올리면 멈추고 "맨 아래로" 버튼을 보인다.
// 새 질문을 보내면 부드럽게 맨 아래로. 말풍선 key 는 대화 + 순서 — 답이 끝나 서버 목록으로 바뀔 때
// 같은 말풍선이 그대로 남아 버튼 줄이 열리는 애니메이션이 끊기지 않는다.

interface Props {
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => void
  t: TFunction
}

export function MessagesList({ copiedMessageKey, onCopy, onDownloadJson, t }: Props) {
  const { messages, messagesEndRef, selectedSessionId } = useAIChat()
  const { ref, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([messages])

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
        {messages.map((message, idx) => (
          <MessageBubble
            key={`${selectedSessionId ?? 'new'}:${idx}`}
            message={message}
            idx={idx}
            copiedMessageKey={copiedMessageKey}
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
