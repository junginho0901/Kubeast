import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'
import { usePanelEscape } from '@/hooks/useDismiss'

interface Props {
  maxItemsPerResource: number
  setMaxItemsPerResource: (n: number) => void
  refetchIntervalMs: number
  setRefetchIntervalMs: (n: number) => void
}

export default function SearchSettings({
  maxItemsPerResource,
  setMaxItemsPerResource,
  refetchIntervalMs,
  setRefetchIntervalMs,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const maxItemsRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [refetchDraft, setRefetchDraft] = useState(refetchIntervalMs)
  usePanelEscape(open, buttonRef, setOpen)

  const save = () => {
    if (maxItemsRef.current) setMaxItemsPerResource(Math.min(10000, Math.max(1, parseInt(maxItemsRef.current.value) || 10000)))
    setRefetchIntervalMs(refetchDraft)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        className="btn btn-secondary h-10 flex items-center gap-2 text-sm"
      >
        <Settings className="w-4 h-4" />
        {t('advancedSearch.settings', 'Settings')}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 w-72 max-w-[calc(100vw-2rem)] bg-slate-800 border border-hairline rounded-xl shadow-xl p-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                {t('advancedSearch.maxItemsLabel', 'Max items per resource')}
              </label>
              <input
                ref={maxItemsRef}
                type="number"
                min={1}
                max={10000}
                defaultValue={maxItemsPerResource}
                className="w-full h-10 px-3 rounded-lg bg-slate-900 border border-control text-ink text-sm focus:outline-hidden focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                {t('advancedSearch.maxItemsHelp', 'Resources exceeding this limit will be excluded to prevent slowdowns.')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                {t('advancedSearch.refetchLabel', 'Refetch interval')}
              </label>
              <CustomDropdown
                testId="search-settings-refetch"
                value={String(refetchDraft)}
                onChange={(v) => setRefetchDraft(Number(v) || 0)}
                options={[
                  { value: '0', label: `Off (${t('advancedSearch.manual', 'Manual refresh only')})` },
                  { value: '30000', label: `30 ${t('advancedSearch.seconds', 'seconds')}` },
                  { value: '60000', label: `1 ${t('advancedSearch.minute', 'minute')}` },
                  { value: '300000', label: `5 ${t('advancedSearch.minutes', 'minutes')}` },
                ]}
              />
            </div>

            <button
              onClick={save}
              className="btn btn-primary w-full text-sm"
            >
              {t('advancedSearch.save', 'Save')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
