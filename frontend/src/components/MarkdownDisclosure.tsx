import { Children, isValidElement, useState, type ReactNode } from 'react'

// <details>/<summary> in chat markdown (tool calls with their arguments and results) as a disclosure button and
// region that opens with the sidebar groups' height transition. The closed region is inert, so what is inside is
// out of the tab order. Pass both to ReactMarkdown: components={{ details: MarkdownDetails, summary: MarkdownSummary }}.

export function MarkdownSummary({ children }: { children?: ReactNode }) {
  return <>{children}</>
}

export function MarkdownDetails({ children, open }: { children?: ReactNode; open?: boolean }) {
  const [isOpen, setOpen] = useState(Boolean(open))
  const parts = Children.toArray(children)
  const summary = parts.find((c) => isValidElement(c) && c.type === MarkdownSummary)
  return (
    <div className="md-details" data-open={isOpen || undefined}>
      <button type="button" className="md-summary" aria-expanded={isOpen} onClick={() => setOpen((o) => !o)}>
        {summary}
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
        inert={!isOpen}
        data-testid="md-details-body"
      >
        <div className="min-h-0 overflow-hidden">{parts.filter((c) => c !== summary)}</div>
      </div>
    </div>
  )
}
