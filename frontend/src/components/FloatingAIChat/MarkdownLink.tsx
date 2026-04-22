import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'

import { useResourceDetail } from '../ResourceDetailContext'
import { parseResourceLink } from '@/utils/resourceLink'

interface MarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode
}

/**
 * react-markdown 이 렌더하는 `<a>` 를 교체하는 커스텀 링크.
 *
 * `href` 가 `kubest://` 로 시작하면 기본 네비게이션을 막고 `useResourceDetail.open()`
 * 으로 상세 드로어를 연다. 그 외 `http(s)://` 등은 기본 동작 (`target="_blank"`,
 * `rel="noopener noreferrer"`) 유지.
 *
 * 잘못된 파라미터(`kubest://pod?ns=../etc&name=<script>`)는 `parseResourceLink` 의
 * DNS-1123 규격 검증을 통과하지 못하면 링크가 **비활성 텍스트**로 렌더된다 (XSS 방어).
 */
export function MarkdownLink({ href, children, ...rest }: MarkdownLinkProps) {
  const { open } = useResourceDetail()

  if (href?.startsWith('kubest://')) {
    const parsed = parseResourceLink(href)
    if (!parsed) {
      // 유효하지 않은 링크 — 텍스트만 렌더 (XSS/오탐 방어)
      return <span className="text-slate-400">{children}</span>
    }
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      open({
        kind: parsed.kind,
        name: parsed.name,
        namespace: parsed.namespace,
      })
    }
    return (
      <a
        href={href}
        onClick={handleClick}
        className="text-primary-400 underline decoration-dotted hover:text-primary-300"
        {...rest}
      >
        {children}
      </a>
    )
  }

  // 외부 링크 기본 동작
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-400 underline hover:text-primary-300"
      {...rest}
    >
      {children}
    </a>
  )
}
