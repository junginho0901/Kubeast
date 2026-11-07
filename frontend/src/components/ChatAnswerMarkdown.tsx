import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { CHAT_MARKDOWN } from '@/components/chatMarkdown'
import { answerChunks } from '@/services/chatTextUtils'

// A piece of an answer: parsed when its letters change and not when the letters after it do.
export const AnswerChunk = memo(function AnswerChunk({ text }: { text: string }) {
  return <ReactMarkdown {...CHAT_MARKDOWN}>{text}</ReactMarkdown>
})

// A chat answer as elements, in both chats. An answer on its way is drawn every few milliseconds and parsing all of it
// takes longer than that past some thousand letters. Keyed by position, so a tool block stays open as what follows it comes.
export function ChatAnswerMarkdown({ content }: { content: string }) {
  const chunks = useMemo(() => answerChunks(content), [content])
  // the blank lines under a piece end it as what follows does in the whole, where an open fence would not take them in
  return <>{chunks.map((text, position) => <AnswerChunk key={position} text={position < chunks.length - 1 ? text.trimEnd() : text} />)}</>
}
