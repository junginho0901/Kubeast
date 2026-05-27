import ConfigMapDetail from './config-storage-info/ConfigMapDetail'
import SecretDetail from './config-storage-info/SecretDetail'
import PVDetail from './config-storage-info/PVDetail'
import PVCDetail from './config-storage-info/PVCDetail'
import StorageClassDetail from './config-storage-info/StorageClassDetail'
import VolumeAttachmentDetail from './config-storage-info/VolumeAttachmentDetail'
import HPADetail from './config-storage-info/HPADetail'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function ConfigStorageInfo({ name, namespace, kind, rawJson }: Props) {
  if (kind === 'ConfigMap') return <ConfigMapDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'Secret') return <SecretDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'PersistentVolume') return <PVDetail name={name} rawJson={rawJson} />
  if (kind === 'PersistentVolumeClaim') return <PVCDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'StorageClass') return <StorageClassDetail name={name} rawJson={rawJson} />
  if (kind === 'VolumeAttachment') return <VolumeAttachmentDetail name={name} rawJson={rawJson} />
  if (kind === 'HorizontalPodAutoscaler') return <HPADetail name={name} namespace={namespace} rawJson={rawJson} />
  return null
}
