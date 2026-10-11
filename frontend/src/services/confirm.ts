import { createContext, useContext } from 'react'

// In-app confirm window (ConfirmProvider) in place of the browser's
// window.confirm(): same frame, wording and Escape behaviour as the rest.
export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  // red box under the message
  warning?: string
  // the confirm button stays off until this exact text is typed
  typeToConfirm?: string
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFn | null>(null)

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm needs ConfirmProvider')
  return confirm
}
