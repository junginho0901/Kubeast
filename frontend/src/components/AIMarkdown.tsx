import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'

import { MarkdownLink } from '@/components/FloatingAIChat/MarkdownLink'
import { aiImageSrc, REMARK_PLUGINS } from '@/utils/markdown'

// Text a model wrote outside the chat (an investigation report, the optimization answer), as Markdown without raw HTML. A
// link opens in a new tab, so following one does not leave the console, and an image keeps only another host's address.
const COMPONENTS = { a: MarkdownLink }
const urlTransform = (url: string, key: string) => (key === 'src' ? aiImageSrc(url) : defaultUrlTransform(url))

export function AIMarkdown({ children }: { children?: string | null }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>{children}</ReactMarkdown>
}
