import { ReactNode, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from '@/services/confirm'
import { ModalFrame } from './ModalFrame'
import { modalButton } from './modalStyles'
import { TypeToConfirm, WarningBox } from './TypeToConfirm'

interface Request {
  options: ConfirmOptions
  resolve: (ok: boolean) => void
}

export default function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null)
  const confirm = useCallback<ConfirmFn>((options) => new Promise((resolve) => setRequest({ options, resolve })), [])
  const done = (ok: boolean) => {
    request?.resolve(ok)
    setRequest(null)
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && <ConfirmDialog options={request.options} onDone={done} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ options, onDone }: { options: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const ready = !options.typeToConfirm || typed === options.typeToConfirm
  return (
    <ModalFrame
      size="sm"
      title={options.title}
      onClose={() => onDone(false)}
      testId="confirm-dialog"
      footer={
        <>
          <button type="button" className={modalButton.cancel} onClick={() => onDone(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            data-testid="confirm-dialog-ok"
            className={options.danger ? modalButton.danger : modalButton.primary}
            disabled={!ready}
            onClick={() => onDone(true)}
          >
            {options.confirmLabel ?? t('common.confirm', { defaultValue: 'Confirm' })}
          </button>
        </>
      }
    >
      {options.message && <p className="text-sm text-slate-300 whitespace-pre-line break-keep">{options.message}</p>}
      {options.warning && <WarningBox>{options.warning}</WarningBox>}
      {options.typeToConfirm && <TypeToConfirm expected={options.typeToConfirm} value={typed} onChange={setTyped} />}
    </ModalFrame>
  )
}
