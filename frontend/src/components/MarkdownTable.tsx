import type { ComponentPropsWithoutRef } from 'react'

// A markdown table in a chat answer, inside a box that scrolls a wide table sideways (lines and the floating panel's
// fixed header row: .chat-table-wrap in index.css). Pass to ReactMarkdown: components={{ table: MarkdownTable }}.
export function MarkdownTable({ node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div className="chat-table-wrap" data-testid="chat-table">
      <table {...props} />
    </div>
  )
}
