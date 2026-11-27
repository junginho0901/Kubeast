import { useState, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  sidebar: ReactNode
  children: ReactNode
}

// Keep both columns mounted: hiding history must not reset its scroll, selection or editing state.
export function ChatColumns({ sidebar, children }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex h-screen min-w-0 flex-col">
      <div className="border-b border-hairline bg-slate-800 px-4 py-2 min-[1280px]:hidden">
        <button
          type="button"
          className="btn btn-secondary inline-flex min-h-10 min-w-10 items-center gap-2 text-sm"
          aria-expanded={expanded}
          aria-controls="ai-chat-session-list"
          data-testid="chat-session-sidebar-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            : <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />}
          {t(expanded ? 'aiChat.hideConversations' : 'aiChat.showConversations')}
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          id="ai-chat-session-list"
          data-testid="chat-session-sidebar-panel"
          className={`${expanded ? 'flex' : 'hidden'} min-h-0 w-64 shrink-0 min-[1280px]:flex`}
        >
          {sidebar}
        </div>
        {children}
      </div>
    </div>
  )
}
