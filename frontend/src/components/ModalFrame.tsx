import { ReactNode, useId } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from './ModalOverlay'

// The one frame for create, edit and confirm windows: title row with a close
// button, the body, and a footer with the buttons on the right. Width comes from the size (sm =
// one or two fields, md = a form, lg = an editor or a checkbox grid); height
// follows the content.
const WIDTH = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-4xl' } as const

interface ModalFrameProps {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  size?: keyof typeof WIDTH
  onClose: () => void
  // while a request runs: no closing by X, Escape or the backdrop
  busy?: boolean
  footer: ReactNode
  footerStart?: ReactNode
  children?: ReactNode
  testId?: string
  zIndex?: number
  // plain (default): the body grows with its content — a scrolling body would
  // clip a form's dropdown menus. scroll: the body scrolls when the window
  // reaches the screen height. fill: the body takes the remaining height and
  // the content picks its own scrolling part (a checkbox grid under fixed fields).
  body?: 'plain' | 'scroll' | 'fill'
}

const BODY = { plain: '', scroll: 'overflow-y-auto min-h-0 flex-1', fill: 'min-h-0 flex-1 flex flex-col' } as const

export function ModalFrame({ title, subtitle, icon, size = 'md', onClose, busy, footer, footerStart, children, testId, body = 'plain', zIndex }: ModalFrameProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const close = busy ? undefined : onClose
  return (
    <ModalOverlay onClose={close} zIndex={zIndex}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`w-full ${WIDTH[size]} max-h-[calc(100vh-2rem)] flex flex-col rounded-xl border border-hairline bg-slate-800 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-4">
          <div className="flex items-start gap-3 min-w-0">
            {icon}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-slate-400 [overflow-wrap:anywhere]">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:text-ink hover:bg-slate-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 hit-area-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {children && <div className={`min-w-0 px-5 pb-1 ${BODY[body]}`}>{children}</div>}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-5">
          {footerStart && <div className="mr-auto min-w-0 text-sm text-slate-400 [overflow-wrap:anywhere]">{footerStart}</div>}
          {footer}
        </div>
      </div>
    </ModalOverlay>
  )
}
