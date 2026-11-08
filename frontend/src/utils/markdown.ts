import remarkGfm from 'remark-gfm'
import { defaultUrlTransform, type Options } from 'react-markdown'

// GFM for AI answers and reports, striking text out only between ~~two tildes~~: answers write ranges as 10~14%, and
// the default (one tilde) struck out everything between two such ranges.
export const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }]] satisfies NonNullable<Options['remarkPlugins']>

const hostOf = (host: string) => host.replace(/\.$/, '')

// An image loads as soon as the text is drawn, and on the console's own host the request carries the viewer's session,
// so only an image of another host keeps its address (the page's Content-Security-Policy says whether it loads).
export function aiImageSrc(url: string): string | null {
  const page = globalThis.location
  try {
    const at = new URL(defaultUrlTransform(url), page?.href)
    return (at.protocol === 'http:' || at.protocol === 'https:') && hostOf(at.hostname) !== hostOf(page?.hostname ?? '') ? url : null
  } catch {
    return null
  }
}
