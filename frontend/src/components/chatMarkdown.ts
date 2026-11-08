import { defaultUrlTransform, type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import { MarkdownLink } from '@/components/FloatingAIChat/MarkdownLink'
import { MarkdownDetails, MarkdownSummary } from '@/components/MarkdownDisclosure'
import { MarkdownTable } from '@/components/MarkdownTable'
import { fenceReader } from '@/services/chatTextUtils'
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
  value?: string
  children?: AnswerNode[]
}

const BLOCKS = new Set(['blockquote', 'details', 'div', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul'])

const holdsBlock = (node: AnswerNode): boolean =>
  node.type === 'element' && (BLOCKS.has(node.tagName ?? '') || (node.children ?? []).some(holdsBlock))

function unwrapLinks(parent: AnswerNode, inSummary: boolean) {
  if (!parent.children) return
  parent.children = parent.children.flatMap((child) => {
    const head = inSummary || child.tagName === 'summary'
    unwrapLinks(child, head)
    return child.tagName === 'a' && (head || child.children?.some(holdsBlock)) ? child.children ?? [] : [child]
  })
}

// An <a> left open takes in every block after it, which would make the rest of the answer and its tool blocks one link. And
// the head of a disclosure is a button, whose press would open the link too.
const keepLinksInline = () => (tree: AnswerNode) => unwrapLinks(tree, false)

// CommonMark's HTML blocks that only their own closing ends: left open, one takes the rest of the answer as raw HTML.
const OPEN_UNTIL_CLOSED: [RegExp, RegExp][] = [
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![a-z]/i, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
]
const TOOL_BLOCK = /^<details>[ \t\r\n]*<summary>🔧/m

// The answer with each such opening that has no closing before the next tool block written as words, so what follows
// reads as Markdown and a tool block or its result stays what it is. Code is left alone.
function openHtmlAsWords(answer: string): string {
  const fenceEnd = fenceReader(answer)
  // how far each closing is known to be missing, so a text of openings stays one pass
  const missingUntil = new Map<RegExp, number>()
  let out = ''
  let at = 0
  while (at < answer.length) {
    const end = fenceEnd(at)
    if (end !== -1) {
      out += answer.slice(at, end)
      at = end
      continue
    }
    const newline = answer.indexOf('\n', at)
    const next = newline === -1 ? answer.length : newline + 1
    const line = answer.slice(at, next)
    const closing = OPEN_UNTIL_CLOSED.find(([opening]) => opening.test(line.replace(/\r?\n$/, '')))?.[1]
    if (!closing) {
      out += line
      at = next
      continue
    }
    let closed = -1
    if (at >= (missingUntil.get(closing) ?? 0)) {
      const toolBlock = answer.slice(next).search(TOOL_BLOCK)
      const until = toolBlock === -1 ? answer.length : next + toolBlock
      const found = closing.exec(answer.slice(at, until))
      if (found) closed = at + found.index
      else missingUntil.set(closing, until)
    }
    if (closed === -1) {
      out += line.replace('<', '&lt;')
      at = next
      continue
    }
    const closedLine = answer.indexOf('\n', closed)
    const blockEnd = closedLine === -1 ? answer.length : closedLine + 1
    out += answer.slice(at, blockEnd)
    at = blockEnd
  }
  return out
}

function readOpenHtmlAsWords(this: { parser?: (document: string, file: never) => unknown }) {
  const parse = this.parser!
  this.parser = (document, file) => parse(openHtmlAsWords(document), file)
}

// Elements that take what follows out of the answer however they end, written as words as rehype-raw's tagfilter does: a
// <template>'s contents are not its children, so the sanitizer drops them whole, a <select> reduces every block after it to
// bare words, and a <col> outside a table, first in an answer, makes the parser drop all that follows.
const TAKES_WHAT_FOLLOWS = /<(\/?)(select|template|col|colgroup|table)(?=[\t\n\f\r />])/gi

function takersAsWords() {
  return (tree: AnswerNode) => {
    let inTable = false
    const write = (node: AnswerNode) => {
      if (node.type === 'raw' && node.value) {
        node.value = node.value.replace(TAKES_WHAT_FOLLOWS, (tag, close: string, name: string) => {
          const element = name.toLowerCase()
          if (element === 'table' || element === 'colgroup') inTable = true
          return element === 'select' || element === 'template' || (element === 'col' && !inTable) ? `&lt;${close}${name}` : tag
        })
      }
      node.children?.forEach(write)
    }
    write(tree)
  }
}

// react-markdown blanks an address of a scheme it does not know; MarkdownLink checks each kubest:// link it gets.
function urlTransform(url: string): string {
  return url.startsWith('kubest://') ? url : defaultUrlTransform(url)
}

export const CHAT_MARKDOWN = {
  remarkPlugins: [...REMARK_PLUGINS, readOpenHtmlAsWords],
  // tagfilter: an element that reads what follows as its own text (style, textarea, …) shows as words instead of hiding it
  rehypePlugins: [takersAsWords, [rehypeRaw, { tagfilter: true }], [rehypeSanitize, ANSWER_SCHEMA], keepLinksInline],
  urlTransform,
  components: { a: MarkdownLink, details: MarkdownDetails, summary: MarkdownSummary, table: MarkdownTable },
} satisfies Options
