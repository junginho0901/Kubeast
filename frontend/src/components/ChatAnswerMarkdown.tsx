import { memo, useMemo } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import { CHAT_MARKDOWN, revealPlaceholders } from '@/components/chatMarkdown'
import { answerChunks } from '@/services/chatTextUtils'
import type { MaskValues } from '@/services/maskValues'

// A piece of an answer: parsed when its letters change and not when the letters after it do. With values, the answer's
// placeholders are drawn as the values the person who asked may read (services/maskValues).
export const AnswerChunk = memo(function AnswerChunk({ text, values }: { text: string; values?: MaskValues | null }) {
  const rehypePlugins = useMemo<Options['rehypePlugins']>(
    () => (values ? [...CHAT_MARKDOWN.rehypePlugins, [revealPlaceholders, values]] : CHAT_MARKDOWN.rehypePlugins),
    [values],
  )
  return <ReactMarkdown {...CHAT_MARKDOWN} rehypePlugins={rehypePlugins}>{text}</ReactMarkdown>
})

// A chat answer as elements, in both chats. An answer on its way is drawn every few milliseconds and parsing all of it
// takes longer than that past some thousand letters. Keyed by position, so a tool block stays open as what follows it comes.
export function ChatAnswerMarkdown({ content, values }: { content: string; values?: MaskValues | null }) {
  const chunks = useMemo(() => answerChunks(content), [content])
  // the blank lines under a piece end it as what follows does in the whole, where an open fence would not take them in
  return <>{chunks.map((text, position) => <AnswerChunk key={position} text={position < chunks.length - 1 ? text.trimEnd() : text} values={values} />)}</>
}
