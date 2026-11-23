import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

import { safeHttpHref } from '@/utils/safeHttpHref'

// A link, in a new tab, to an address the console did not write; one that is not an http or https URL is shown as
// words with the address on hover (safeHttpHref).
export function ExternalHttpLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeHttpHref(url)
  if (!href) {
    return <span className="inline-flex items-center gap-1 text-slate-400" title={url} data-testid="address-as-text">{children}</span>
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary-300 hover:underline">
      <ExternalLink className="w-3.5 h-3.5" /> {children}
    </a>
  )
}
