import { useResourceDetail } from '@/components/ResourceDetailContext'

interface ResourceLinkProps {
  kind: string
  name: string
  namespace?: string
}

export function ResourceLink({ kind, name, namespace }: ResourceLinkProps) {
  const { open } = useResourceDetail()

  return (
    <button
      type="button"
      className="text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        open({ kind, name, namespace })
      }}
    >
      {name}
    </button>
  )
}
