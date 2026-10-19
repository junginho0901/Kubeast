import { User, Check, Copy } from 'lucide-react'
import { turnUsageText } from '@/utils/turnUsage'
import ReactMarkdown from 'react-markdown'
import { REMARK_PLUGINS } from '@/utils/markdown'
import rehypeRaw from 'rehype-raw'
import type { TFunction } from 'i18next'
import type { Message } from './types'
import { truncateToolResultsInContent } from './messageContent'
import { ApprovalCard } from './ApprovalCard'
import { MarkdownDetails, MarkdownSummary } from '@/components/MarkdownDisclosure'
import { MarkdownTable } from '@/components/MarkdownTable'
import { ChatCharts } from '@/components/ChatChart'

// 단일 메시지 말풍선 — user / assistant(Kubeast 아이콘) 아바타 + 콘텐츠 + 답변 대기 중인 로딩 점 +
// (assistant 의 경우) 아래쪽 사용량 / Copy / Download ZIP 줄. 그 줄은 답이 나오는 동안 닫혀 있다가
// 끝나거나 멈추면 공간이 열리고(그리드 행 0fr → 1fr) 내용이 그 자리에서 서서히 나타난다.

interface Props {
  message: Message
  idx: number
  copiedMessageKey: string | null
  onCopy: (message: Message, key: string) => void
  onDownloadJson: (message: Message) => void
  t: TFunction
}

export function MessageBubble({ message, idx, copiedMessageKey, onCopy, onDownloadJson, t }: Props) {
  const messageKey = message.id != null ? `db-${message.id}` : `tmp-${idx}`
  const settled = message.role === 'assistant' && !message.isTemporary
  const showCopyButton = settled && Boolean(message.content)
  const usage = message.role === 'assistant' && !message.isTemporary ? turnUsageText(t, message.usage) : null
  const isCopied = copiedMessageKey === messageKey
  return (
    <div className={`flex gap-3 p-6 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
      {message.role === 'user' ? (
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-primary-500">
          <User className="w-5 h-5 text-white" />
        </div>
      ) : (
        <img src="/icon.svg" alt="" className="shrink-0 w-8 h-8" data-testid="assistant-avatar" />
      )}
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

            return (
              <>
                {message.role === 'user' ? (
                  // what was typed, line breaks included (markdown would join Shift+Enter lines)
                  <p className="m-0 whitespace-pre-wrap wrap-break-word" data-testid="user-message-text">
                    {message.content}
                  </p>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={[rehypeRaw]}
                    components={{ details: MarkdownDetails, summary: MarkdownSummary, table: MarkdownTable }}
                  >
                    {truncateToolResultsInContent(message.content)}
                  </ReactMarkdown>
                )}
                {message.role === 'assistant' && <ChatCharts toolCalls={message.toolCalls} />}
                {message.role === 'assistant' &&
                  (message.toolCalls || [])
                    .filter((tc: any) => tc && tc.approval_id)
                    .map((tc: any) => (
                      <ApprovalCard
                        key={String(tc.approval_id)}
                        approvalId={String(tc.approval_id)}
                        tool={String(tc.function || '')}
                        args={tc.args}
                        cluster={tc.cluster}
                        initialStatus={tc.approval_status}
                      />
                    ))}
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
        {message.role === 'assistant' && (
          // closed while the answer comes; when it ends or stops the row's space opens, then its contents fade in
          <div
            className={`not-prose grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
              settled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
            data-testid="message-actions-row"
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={`mt-3 flex h-7 justify-end gap-2 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                  settled ? 'opacity-100 delay-200 motion-reduce:delay-0' : 'opacity-0'
                }`}
                inert={!settled}
                data-testid="message-actions"
              >
                {usage && (
                  <span className="mr-auto self-center text-[11px] text-slate-400" title={usage.title} data-testid="turn-usage">
                    {usage.text}
                  </span>
                )}
                {showCopyButton && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onCopy(message, messageKey)
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-sm bg-slate-600 hover:bg-slate-500 text-slate-100"
                    title={isCopied ? t('aiChat.copied') : t('aiChat.copyMessage')}
                  >
                    {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{isCopied ? t('aiChat.copied') : t('aiChat.copyMessage')}</span>
                  </button>
                )}
                {message.content && message.toolCalls && message.toolCalls.length > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onDownloadJson(message)
                    }}
                    className="px-2.5 py-1 text-xs rounded-sm bg-slate-600 hover:bg-slate-500 text-slate-100"
                  >
                    {t('aiChat.resultZipDownload')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
