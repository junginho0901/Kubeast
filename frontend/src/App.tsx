import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Namespaces from './pages/Namespaces'
import Resources from './pages/Resources'
import Topology from './pages/Topology'
import AIChat from './pages/AIChat'
import ClusterView from './pages/ClusterView'
import Monitoring from './pages/Monitoring'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="namespaces" element={<Namespaces />} />
          <Route path="monitoring" element={<Monitoring />} />
          <Route path="cluster-view" element={<ClusterView />} />
          <Route path="resources/:namespace" element={<Resources />} />
          <Route path="topology/:namespace" element={<Topology />} />
          <Route path="ai-chat" element={<AIChat />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
