import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

// "Type the name to confirm" field for deletes that are hard to undo.
export function TypeToConfirm({ expected, value, onChange }: { expected: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="mt-4">
      <label className="block text-xs font-semibold text-slate-400 mb-1" htmlFor="type-to-confirm">
        {t('common.typeToConfirm', { defaultValue: 'Type the name to confirm' })}
      </label>
      <p className="mb-2 font-mono text-sm text-white break-all">{expected}</p>
      <input
        id="type-to-confirm"
        data-testid="type-to-confirm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={expected}
        className="w-full h-10 rounded-lg bg-slate-950/60 border border-slate-700 px-3 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-hidden focus:border-red-500"
      />
    </div>
  )
}

export function WarningBox({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs text-red-300 p-2 bg-red-500/10 border border-red-500/20 rounded-lg break-keep whitespace-pre-line">{children}</p>
}
