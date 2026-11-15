import remarkGfm from 'remark-gfm'
import { defaultUrlTransform, type Options } from 'react-markdown'

// GFM for AI answers and reports, striking text out only between ~~two tildes~~: answers write ranges as 10~14%, and
// the default (one tilde) struck out everything between two such ranges.
export const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }]] satisfies NonNullable<Options['remarkPlugins']>

const hostOf = (host: string) => host.replace(/\.$/, '')

// An image on the console's own host would be a request carrying the viewer's session, so only another host's keeps its address.
export function aiImageSrc(url: string): string | null {
  const page = globalThis.location
  try {
    const at = new URL(defaultUrlTransform(url), page?.href)
    return (at.protocol === 'http:' || at.protocol === 'https:') && hostOf(at.hostname) !== hostOf(page?.hostname ?? '') ? url : null
  } catch {
    return null
  }
}

interface AnswerNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: AnswerNode[]
}

function linkImages(parent: AnswerNode) {
  parent.children = parent.children?.map((child) => {
    if (child.type !== 'element' || child.tagName !== 'img') {
      linkImages(child)
      return child
    }
    const { src, alt, title } = child.properties ?? {}
    const href = typeof src === 'string' ? aiImageSrc(src) : null
    const text = (typeof alt === 'string' && alt) || href
    const children = text ? [{ type: 'text', value: text }] : []
    const properties = typeof title === 'string' ? { title } : {}
    return href ? { type: 'element', tagName: 'a', properties: { ...properties, href }, children } : { type: 'element', tagName: 'span', properties, children }
  })
}

// Drawing AI-written text fetches no image (another host's is a link, the console's own its text); runs before keepLinksInline.
export const imagesAsLinks = () => (tree: AnswerNode) => linkImages(tree)

const BLOCKS = new Set(['blockquote', 'details', 'div', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul'])

const holdsBlock = (node: AnswerNode): boolean =>
  node.type === 'element' && (BLOCKS.has(node.tagName ?? '') || (node.children ?? []).some(holdsBlock))

function unwrapLinks(parent: AnswerNode, inSummary: boolean, inLink: boolean) {
  if (!parent.children) return
  parent.children = parent.children.flatMap((child) => {
    const head = inSummary || child.tagName === 'summary'
    const link = child.tagName === 'a'
    unwrapLinks(child, head, inLink || link)
    return link && (head || inLink || child.children?.some(holdsBlock)) ? child.children ?? [] : [child]
  })
}

// An <a> left open takes in every block after it, which would make the rest of the answer and its tool blocks one link. The
// head of a disclosure is a button, whose press would open the link too, and a link inside a link would open in its place.
export const keepLinksInline = () => (tree: AnswerNode) => unwrapLinks(tree, false, false)
