import { Bot, User, Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import { truncateToolResultsInContent } from './messageContent'

// 단일 메시지 말풍선 — user / assistant 아바타 + 콘텐츠 + (assistant 의 경우)
// Copy / Download ZIP 버튼 + 답변 대기 중인 로딩 점. AIChat.tsx 의 ~115줄
// 인라인 JSX 를 그대로 떼옴.

interface Props {
  message: Message
  idx: number
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => void
  t: TFunction
}

export function MessageBubble({ message, idx, copiedMessageKey, onCopy, onDownloadJson, t }: Props) {
  return (
    <div
      key={message.id != null ? `db-${message.id}` : `tmp-${idx}`}
      className={`flex gap-3 p-6 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
    >
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          message.role === 'user'
            ? 'bg-primary-500'
            : 'bg-gradient-to-br from-purple-500 to-pink-500'
        }`}
      >
        {message.role === 'user' ? (
          <User className="w-5 h-5 text-white" />
        ) : (
          <Bot className="w-5 h-5 text-white" />
        )}
      </div>
      <div
        className={`flex-1 p-4 rounded-lg prose prose-invert max-w-3xl overflow-x-auto ${
          message.role === 'user'
            ? 'bg-primary-600 text-white'
            : 'bg-slate-700 text-slate-100'
        }`}
      >
        {(() => {
          const hasContent = message.content && message.content.length > 0

          if (hasContent) {
            const hasToolCalls = message.content.includes('🔧') || message.content.includes('<summary>🔧')
            const isWaitingForAnswer =
              message.isTemporary &&
              message.role === 'assistant' &&
              (message.streamingPhase === 'waiting' || message.streamingPhase === 'tools')

            const messageKey = message.id != null ? `db-${message.id}` : `tmp-${idx}`
            const showCopyButton = message.role === 'assistant' && !message.isTemporary
            const isCopied = copiedMessageKey === messageKey
            return (
              <>
                {(showCopyButton || (message.toolCalls && message.toolCalls.length > 0)) && (
                  <div className="flex justify-end gap-2 mb-2">
                    {showCopyButton && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onCopy(message, messageKey)
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 text-slate-100"
                        title={isCopied ? t('aiChat.copied') : t('aiChat.copyMessage')}
                      >
                        {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{isCopied ? t('aiChat.copied') : t('aiChat.copyMessage')}</span>
                      </button>
                    )}
                    {message.toolCalls && message.toolCalls.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onDownloadJson(message)
                        }}
                        className="px-2.5 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 text-slate-100"
                      >
                        {t('aiChat.resultZipDownload')}
                      </button>
                    )}
                  </div>
                )}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
                >
                  {message.role === 'assistant'
                    ? truncateToolResultsInContent(message.content)
                    : message.content}
                </ReactMarkdown>
                {hasToolCalls && isWaitingForAnswer && (
                  <div className="flex gap-2 items-center py-3 mt-4">
                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                    <div
                      className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                      style={{ animationDelay: '0.1s' }}
                    />
                    <div
                      className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                      style={{ animationDelay: '0.2s' }}
                    />
                  </div>
                )}
              </>
            )
          } else if (message.role === 'assistant') {
            return (
              <div className="flex gap-2 items-center py-1">
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                <div
                  className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                  style={{ animationDelay: '0.1s' }}
                />
                <div
                  className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                  style={{ animationDelay: '0.2s' }}
                />
              </div>
            )
          }
          return null
        })()}
      </div>
    </div>
  )
}
