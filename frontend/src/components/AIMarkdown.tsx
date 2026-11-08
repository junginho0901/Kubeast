import ReactMarkdown from 'react-markdown'

import { MarkdownLink } from '@/components/FloatingAIChat/MarkdownLink'
import { REMARK_PLUGINS } from '@/utils/markdown'

// Text a model wrote outside the chat (an investigation report, the optimization answer), as Markdown without raw HTML. A
// link opens in a new tab, so following one does not leave the console.
const COMPONENTS = { a: MarkdownLink }

export function AIMarkdown({ children }: { children?: string | null }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>
}
