import SectionTab from './SectionTab'

export default function NotesTab({ namespace, name }: { namespace: string; name: string }) {
  return <SectionTab namespace={namespace} name={name} section="notes" />
}
