import { useResourceDetail } from '@/components/ResourceDetailContext'
import { detailTarget } from './crDetail'

interface ResourceLinkProps {
  kind: string
  name: string
  namespace?: string
  // the reference's apiVersion where it has one (ownerReferences, scaleTargetRef), so a Kind two groups serve opens
  // the right group's object
  apiVersion?: string
}

export function ResourceLink({ kind, name, namespace, apiVersion }: ResourceLinkProps) {
  const { open } = useResourceDetail()

  return (
    <button
      type="button"
      className="max-w-full break-all text-left text-primary-400 hover:text-primary-300 hover:underline cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-primary-500"
      onClick={(e) => {
        e.stopPropagation()
        open(detailTarget(kind, name, namespace, apiVersion))
      }}
    >
      {name}
    </button>
  )
}
