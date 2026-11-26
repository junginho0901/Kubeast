import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

import { safeHttpHref } from '@/utils/safeHttpHref'

// A link, in a new tab, to an address the console did not write; one that is not an http or https URL is shown as
// words with the address on hover (safeHttpHref).
export function ExternalHttpLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeHttpHref(url)
  if (!href) {
    return <span className="inline-flex max-w-full items-center gap-1 text-notice-text-empty [overflow-wrap:anywhere]" title={url} data-testid="address-as-text">{children}</span>
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 rounded-sm text-primary-400 [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400">
      <ExternalLink className="w-3.5 h-3.5 shrink-0" /> {children}
    </a>
  )
}
