import { useTranslation } from 'react-i18next'
import CustomDropdown from '@/components/CustomDropdown'
import { PAGE_SIZES, setPageSize, usePageSize } from '@/utils/pageSize'

// Rows per page in a list table's footer — one choice shared by every list (utils/pageSize).
export function PageSizeSelect() {
  const { t } = useTranslation()
  const size = usePageSize()
  return (
    <div className="flex items-center gap-2" data-testid="page-size">
      <span className="whitespace-nowrap">{t('common.pageSize.label', { defaultValue: 'Rows' })}</span>
      <CustomDropdown
        size="sm"
        placement="up"
        className="w-24"
        testId="page-size-select"
        value={String(size)}
        onChange={(v) => setPageSize(v === 'fit' ? 'fit' : (Number(v) as 25 | 50 | 100))}
        options={PAGE_SIZES.map((s) => ({
          value: String(s),
          label: s === 'fit' ? t('common.pageSize.fit', { defaultValue: 'Fit' }) : String(s),
        }))}
      />
    </div>
  )
}
