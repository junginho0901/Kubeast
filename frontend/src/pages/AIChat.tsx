import { AIChatProvider } from './ai-chat/AIChatProvider'
import { AIChatBody } from './ai-chat/AIChatBody'

// 페이지 root: state Provider 만 wrap. 실제 로직은 AIChatBody.
export default function AIChat() {
  return (
    <AIChatProvider>
      <AIChatBody />
    </AIChatProvider>
  )
}
