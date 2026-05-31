import { DashboardProvider } from './dashboard/DashboardContext'
import { DashboardBody } from './dashboard/DashboardBody'

// 페이지 root: modal/filter state Provider 만 wrap. 실제 로직은 DashboardBody.
export default function Dashboard() {
  return (
    <DashboardProvider>
      <DashboardBody />
    </DashboardProvider>
  )
}
