import { useEffect } from 'react'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import { MessageBubble } from './MessageBubble'
import { useAIChat } from './AIChatContext'

// 메시지 리스트 + 자동 scroll-to-bottom. 매 messages 변경 시 끝으로 스크롤.
// (streaming 중 partial 업데이트도 dep 으로 안 깨지도록 messages 배열 전체 의존)

interface Props {
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => void
  t: TFunction
}

export function MessagesList({ copiedMessageKey, onCopy, onDownloadJson, t }: Props) {
  const { messages, messagesEndRef } = useAIChat()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, messagesEndRef])

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((message, idx) => (
        <MessageBubble
          key={message.id != null ? `db-${message.id}` : `tmp-${idx}`}
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
  )
}
