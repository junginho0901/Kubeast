import type { ImgHTMLAttributes } from 'react'

import { MarkdownLink } from '@/components/FloatingAIChat/MarkdownLink'
import { aiImageSrc } from '@/utils/markdown'

// Drawing AI-written text fetches nothing: another host's image is a link the reader opens, the console's own its text only.
export function AnswerImage({ node: _node, src, alt, title }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const href = typeof src === 'string' ? aiImageSrc(src) : null
  if (!href) return <span title={title}>{alt}</span>
  return <MarkdownLink href={href} title={title}>{alt || href}</MarkdownLink>
}
