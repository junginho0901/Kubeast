import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { REMARK_PLUGINS } from '@/utils/markdown'
import rehypeRaw from 'rehype-raw'
import { MarkdownDetails, MarkdownSummary } from '@/components/MarkdownDisclosure'
import { MarkdownTable } from '@/components/MarkdownTable'
import { stripToolDetails } from '@/services/chatTextUtils'
import { ChatCharts } from '@/components/ChatChart'

import { MarkdownLink } from './MarkdownLink'

/**
 * react-markdown v10 의 기본 urlTransform 은 unknown scheme 을 sanitize 한다.
 * `kubest://` 도 unknown 으로 보고 빈 문자열로 만들기 때문에 MarkdownLink 가
 * 받는 href 가 비어 있어 클릭 시 현재 URL 로 새로고침된다.
 *
 * 우리는 `kubest://` 를 신뢰한다 (DNS-1123 검증은 MarkdownLink 가 한 번 더 함)
 * 그 외 URL 은 기본 sanitize 유지.
 */
function urlTransform(url: string): string {
  if (typeof url === 'string' && url.startsWith('kubest://')) return url
  return defaultUrlTransform(url)
}

export interface DisplayMessage {
  id: string | number
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  // the saved tool calls: the graphs the AI asked to show come from here
  toolCalls?: unknown[]
}

interface MessageListProps {
  messages: DisplayMessage[]
  /** the answer so far while one is coming ('' before its first letter) */
  streamingContent?: string
  /** that answer's tool calls so far (its graphs show as soon as their results come) */
  streamingToolCalls?: unknown[]
  streaming?: boolean
  error?: string | null
  /** 메시지가 없을 때 리스트 영역에 끼워 넣을 노드 (예: 추천 질문) */
  emptyExtras?: ReactNode
}

const MARKDOWN_COMPONENTS = { a: MarkdownLink, details: MarkdownDetails, summary: MarkdownSummary, table: MarkdownTable }

/**
 * 플로팅 채팅 패널의 메시지 리스트 (스크롤·"맨 아래로"는 ChatPanel 의 useStickToBottom).
 *
 * - assistant 메시지는 Kubeast 아이콘과 함께 react-markdown 으로 렌더, `<a>` 는 `MarkdownLink` 로 교체
 *   → `kubest://` 링크 클릭 시 리소스 상세 드로어 자동 오픈
 * - 답의 첫 글자 전에는 AI 채팅과 같은 점 세 개
 * - 끝난 답은 말풍선 오른쪽 아래 바깥에 작은 복사 아이콘 (토큰 줄은 두지 않음)
 */
export function MessageList({ messages, streamingContent, streamingToolCalls, streaming, error, emptyExtras }: MessageListProps) {
  const { t } = useTranslation()

  if (messages.length === 0 && !streaming && !error) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-6 text-center text-sm text-slate-500">
          <p>{t('floatingChat.emptyHint', { defaultValue: 'Ask a question about the current page.' })}</p>
          <p className="mt-1 text-xs">
            {t('floatingChat.emptyExamples', {
              defaultValue: 'e.g. "What\'s this?", "Any issues?", "Why is this?"',
            })}
          </p>
        </div>
        {emptyExtras}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} role={msg.role} content={msg.content} pending={msg.pending} toolCalls={msg.toolCalls} />
      ))}
      {streaming ? <MessageBubble role="assistant" content={streamingContent ?? ''} pending toolCalls={streamingToolCalls} /> : null}
      {error ? (
        <div className="rounded-md border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  )
}

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  toolCalls?: unknown[]
}

function MessageBubble({ role, content, pending, toolCalls }: MessageBubbleProps) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className={`max-w-[85%] rounded-lg bg-primary-600 px-3 py-2 text-sm text-white ${pending ? 'opacity-90' : ''}`}>
          <p className="whitespace-pre-wrap wrap-break-word">{content}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-end gap-1.5" data-testid="floating-answer">
      <img src="/icon.svg" alt="" className="mb-auto mt-1 h-5 w-5 shrink-0" data-testid="floating-assistant-avatar" />
      <div className={`min-w-0 max-w-[80%] rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100 ${pending ? 'opacity-90' : ''}`}>
        {content ? (
          <div className="chat-md floating-md prose prose-invert prose-sm max-w-none wrap-break-word">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[rehypeRaw]} urlTransform={urlTransform} components={MARKDOWN_COMPONENTS}>
              {content}
            </ReactMarkdown>
            <ChatCharts toolCalls={toolCalls} />
          </div>
        ) : (
          <div className="flex items-center gap-2 py-1" data-testid="floating-waiting">
            <div className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
            <div className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: '0.1s' }} />
            <div className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: '0.2s' }} />
          </div>
        )}
      </div>
      {!pending && content ? <CopyAnswer content={content} /> : null}
    </div>
  )
}

// The finished answer's copy control, in the empty space at the bubble's bottom right: faint until pointed at, a
// check for 1.5 s after copying; it fades in where it stands when the answer ends.
function CopyAnswer({ content }: { content: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const label = copied ? t('floatingChat.copied', { defaultValue: 'Copied' }) : t('floatingChat.copy', { defaultValue: 'Copy' })
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(stripToolDetails(content))
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // clipboard refused (insecure context): nothing to show
        }
      }}
      aria-label={label}
      title={label}
      data-testid="floating-copy"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-50 transition-opacity duration-200 hover:bg-slate-800 hover:text-slate-200 hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none starting:opacity-0"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}
