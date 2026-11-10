import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import type { SessionDetail } from '@/services/api/types'
import type { Message } from './types'
import type { ExportOutcome } from './exportToolCalls'
import { ChatWelcome } from './ChatWelcome'
import { MessageInput } from './MessageInput'
import { MessagesList } from './MessagesList'
import { ChatHeader } from './ChatHeader'
import { useAIChat } from './AIChatContext'
import { ActionFailure } from '@/components/ActionFailure'

// AIChat 우측 패널 — Header / (Welcome | MessagesList) / MessageInput.
// 메시지 0개 + selectedSession 없거나 임시 일 때 welcome 화면, 아니면 messages 리스트.

const isTempSessionId = (id: string | null) => typeof id === 'string' && id.startsWith('temp:')

interface Props {
  sessionDetail?: SessionDetail
  isStreaming: boolean
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => Promise<ExportOutcome>
  onSend: (q?: string) => void
  onStop: () => void
  // why the stopped answer was not saved (it stays on screen, but not in the conversation)
  stopSaveFailure?: unknown
  t: TFunction
}

export function ChatMain({
  sessionDetail,
  isStreaming,
  copiedMessageKey,
  onCopy,
  onDownloadJson,
  onSend,
  onStop,
  stopSaveFailure = null,
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
          sessionDetail={sessionDetail}
          copiedMessageKey={copiedMessageKey}
          onCopy={onCopy}
          onDownloadJson={onDownloadJson}
          t={t}
        />
      )}

      <ActionFailure error={stopSaveFailure} action="save" testId="chat-stop-save-error" className="px-6 pb-2" />
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
