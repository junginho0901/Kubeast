import SectionTab from './SectionTab'

export default function ManifestTab({ namespace, name }: { namespace: string; name: string }) {
  return <SectionTab namespace={namespace} name={name} section="manifest" />
}
