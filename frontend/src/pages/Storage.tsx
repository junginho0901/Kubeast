import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import ComingSoon from './ComingSoon'
import PersistentVolumeClaims from './storage/PersistentVolumeClaims'
import PersistentVolumes from './storage/PersistentVolumes'
import StorageClasses from './storage/StorageClasses'

type StorageTab = 'pvcs' | 'pvs' | 'storageclasses' | 'volumeattachments'

function normalizeTab(value: string | null): StorageTab {
  const v = (value || '').toLowerCase()
  if (v === 'pvs') return 'pvs'
  if (v === 'storageclasses') return 'storageclasses'
  if (v === 'volumeattachments') return 'volumeattachments'
  return 'pvcs'
}

export default function Storage() {
  const [searchParams] = useSearchParams()
  const tab = useMemo(() => normalizeTab(searchParams.get('tab')), [searchParams])

  if (tab === 'pvcs') return <PersistentVolumeClaims />
  if (tab === 'pvs') return <PersistentVolumes />
  if (tab === 'storageclasses') return <StorageClasses />
  return <ComingSoon title="Volume Attachments" />
}
