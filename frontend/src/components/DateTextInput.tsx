import { useTranslation } from 'react-i18next'
import { parseTypedTime } from '@/utils/time'

// A date (or a date and a minute) typed as YYYY-MM-DD[ HH:mm] — the form the
// times on screen use, in every language. An <input type="date"> shows the
// browser's locale format instead (MDN), whatever the page language is.

interface Props {
  value: string
  onChange: (text: string) => void
  withTime?: boolean
  testId?: string
  className?: string
}

export function DateTextInput({ value, onChange, withTime = false, testId, className = 'h-10' }: Props) {
  const { t } = useTranslation()
  const format = withTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'
  const invalid = value.trim() !== '' && !parseTypedTime(value, withTime)
  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={format}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        className={`mt-1 block ${withTime ? 'w-44' : 'w-32'} ${className} rounded-lg border bg-slate-900 px-2 font-mono text-sm text-white placeholder-slate-500 ${invalid ? 'border-red-500' : 'border-slate-600'}`}
      />
      {invalid && (
        <span className="mt-1 block text-[11px] font-normal text-red-300">
          {t('common.dateFormatHint', { format, defaultValue: 'Enter it as {{format}}.' })}
        </span>
      )}
    </>
  )
}
