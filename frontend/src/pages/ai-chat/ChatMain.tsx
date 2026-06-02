import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import { ChatWelcome } from './ChatWelcome'
import { MessageInput } from './MessageInput'
import { MessagesList } from './MessagesList'
import { ChatHeader } from './ChatHeader'
import { useAIChat } from './AIChatContext'

// AIChat 우측 패널 — Header / (Welcome | MessagesList) / MessageInput.
// 메시지 0개 + selectedSession 없거나 임시 일 때 welcome 화면, 아니면 messages 리스트.

const isTempSessionId = (id: string | null) => typeof id === 'string' && id.startsWith('temp:')

interface Props {
  isStreaming: boolean
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => void
  onSend: (q?: string) => void
  onStop: () => void
  t: TFunction
}

export function ChatMain({
  isStreaming,
  copiedMessageKey,
  onCopy,
  onDownloadJson,
  onSend,
  onStop,
  t,
}: Props) {
  const { messages, input, setInput, selectedSessionId } = useAIChat()

  const quickQuestions = useMemo(
    () => (t('aiChat.quickQuestions', { returnObjects: true }) as string[]) || [],
    [t],
  )

  return (
    <div className="flex-1 flex flex-col">
      <ChatHeader />

      {messages.length === 0 && (!selectedSessionId || isTempSessionId(selectedSessionId)) ? (
        <ChatWelcome
          emptyTitle={t('aiChat.emptyTitle')}
          emptySubtitle={t('aiChat.emptySubtitle')}
          questions={quickQuestions}
          onSelectQuestion={(q) => onSend(q)}
        />
      ) : (
        <MessagesList
          copiedMessageKey={copiedMessageKey}
          onCopy={onCopy}
          onDownloadJson={onDownloadJson}
          t={t}
        />
      )}

      <MessageInput
        value={input}
        onChange={setInput}
        onSubmit={() => onSend()}
        onStop={onStop}
        isStreaming={isStreaming}
        placeholder={t('aiChat.inputPlaceholder')}
        sendLabel={t('aiChat.send')}
        stopLabel={t('aiChat.stop')}
      />
    </div>
  )
}
