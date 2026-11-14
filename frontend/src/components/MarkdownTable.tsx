import type { ComponentPropsWithoutRef } from 'react'

// A markdown table in a chat answer, inside a box that scrolls a wide table sideways (lines and the floating panel's
// fixed header row: .chat-table-wrap in index.css). Pass to ReactMarkdown: components={{ table: MarkdownTable }}.
// Its rows are what one answer wrote, so it takes no list footer (data-list-bounded, the list guard).
export function MarkdownTable({ node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div className="chat-table-wrap" data-testid="chat-table" data-list-bounded="the rows one AI answer wrote">
      <table {...props} />
    </div>
  )
}
