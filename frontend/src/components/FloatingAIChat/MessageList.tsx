import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

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
}

interface MessageListProps {
  messages: DisplayMessage[]
  streamingContent?: string
  error?: string | null
  /** 메시지가 없을 때 리스트 영역에 끼워 넣을 노드 (예: 추천 질문) */
  emptyExtras?: ReactNode
}

/**
 * 플로팅 채팅 패널의 메시지 리스트.
 *
 * - assistant 메시지는 react-markdown 으로 렌더, `<a>` 는 `MarkdownLink` 로 교체
 *   → `kubest://` 링크 클릭 시 리소스 상세 드로어 자동 오픈
 * - 새 메시지 도착 시 자동 스크롤
 */
export function MessageList({ messages, streamingContent, error, emptyExtras }: MessageListProps) {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, streamingContent])

  if (messages.length === 0 && !streamingContent) {
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
        <MessageBubble key={msg.id} role={msg.role} content={msg.content} pending={msg.pending} />
      ))}
      {streamingContent ? (
        <MessageBubble role="assistant" content={streamingContent} pending />
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  )
}

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

function MessageBubble({ role, content, pending }: MessageBubbleProps) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-primary-600 text-white'
            : 'bg-slate-800 text-slate-100'
        } ${pending ? 'opacity-90' : ''}`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none break-words">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              urlTransform={urlTransform}
              components={{ a: MarkdownLink }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
