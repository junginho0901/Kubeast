import { defaultUrlTransform, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import { MarkdownLink } from '@/components/FloatingAIChat/MarkdownLink'
import { MarkdownDetails, MarkdownSummary } from '@/components/MarkdownDisclosure'
import { MarkdownTable } from '@/components/MarkdownTable'
import { REMARK_PLUGINS } from '@/utils/markdown'

// How a chat answer becomes elements, the same in AI Chat and the floating chat. An answer is text a model wrote after
// reading the cluster, so it draws only these elements and attributes, and none of them acts outside the answer.

// Markdown writes footnote ids with their prefix already, so the sanitizer must not add its own and nothing else keeps an id.
const FOOTNOTE_ID = /^user-content-fn(?:ref)?-/
const TABLE_CELL: NonNullable<SanitizeSchema['attributes']>[string] = [['align', 'left', 'center', 'right'], 'colSpan', 'rowSpan']

const ANSWER_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  clobber: [],
  tagNames: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
    'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp',
    'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
  ],
  attributes: {
    a: ['href', 'title', 'ariaLabel', ['ariaDescribedBy', 'footnote-label'], ['id', FOOTNOTE_ID], 'dataFootnoteRef', 'dataFootnoteBackref', ['className', 'data-footnote-backref']],
    abbr: ['title'],
    code: [['className', /^language-./]],
    col: ['span'],
    colgroup: ['span'],
    details: ['open'],
    h2: [['id', 'footnote-label'], ['className', 'sr-only']],
    img: ['src', 'alt', 'title'],
    input: ['checked', ['disabled', true], ['type', 'checkbox']],
    li: [['id', FOOTNOTE_ID], ['className', 'task-list-item']],
    ol: ['start', ['className', 'contains-task-list']],
    section: ['dataFootnotes', ['className', 'footnotes']],
    td: TABLE_CELL,
    th: [...TABLE_CELL, 'scope'],
    time: ['dateTime'],
    ul: [['className', 'contains-task-list']],
  },
  protocols: {
    href: ['http', 'https', 'irc', 'ircs', 'mailto', 'xmpp', 'kubest'],
    src: ['http', 'https'],
  },
}

interface AnswerNode {
  type: string
  tagName?: string
  children?: AnswerNode[]
}

const BLOCKS = new Set(['blockquote', 'details', 'div', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul'])

const holdsBlock = (node: AnswerNode): boolean =>
  node.type === 'element' && (BLOCKS.has(node.tagName ?? '') || (node.children ?? []).some(holdsBlock))

function unwrapLinksAroundBlocks(parent: AnswerNode) {
  if (!parent.children) return
  parent.children = parent.children.flatMap((child) => {
    unwrapLinksAroundBlocks(child)
    return child.tagName === 'a' && child.children?.some(holdsBlock) ? child.children : [child]
  })
}

// An <a> left open takes in every block after it, which would make the rest of the answer and its tool blocks one link.
const keepLinksInline = () => unwrapLinksAroundBlocks

// react-markdown blanks an address of a scheme it does not know; MarkdownLink checks each kubest:// link it gets.
function urlTransform(url: string): string {
  return url.startsWith('kubest://') ? url : defaultUrlTransform(url)
}

export const CHAT_MARKDOWN = {
  remarkPlugins: REMARK_PLUGINS,
  // tagfilter: an element that reads what follows as its own text (style, textarea, …) shows as words instead of hiding it
  rehypePlugins: [[rehypeRaw, { tagfilter: true }], [rehypeSanitize, ANSWER_SCHEMA], keepLinksInline],
  urlTransform,
  components: { a: MarkdownLink, details: MarkdownDetails, summary: MarkdownSummary, table: MarkdownTable },
} satisfies Options
