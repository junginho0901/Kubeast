import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import CustomDropdown from '@/components/CustomDropdown'

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
  const [refetchDraft, setRefetchDraft] = useState(refetchIntervalMs)

  const save = () => {
    if (maxItemsRef.current) setMaxItemsPerResource(parseInt(maxItemsRef.current.value) || 10000)
    setRefetchIntervalMs(refetchDraft)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-slate-300 transition-colors"
      >
        <Settings className="w-4 h-4" />
        {t('advancedSearch.settings', 'Settings')}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 w-80 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl p-4 space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                {t('advancedSearch.maxItemsLabel', 'Max items per resource')}
              </label>
              <input
                ref={maxItemsRef}
                type="number"
                defaultValue={maxItemsPerResource}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-white text-sm focus:outline-hidden focus:border-sky-500"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                {t('advancedSearch.maxItemsHelp', 'Resources exceeding this limit will be excluded to prevent slowdowns.')}
              </p>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
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
              className="w-full py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
            >
              {t('advancedSearch.save', 'Save')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
