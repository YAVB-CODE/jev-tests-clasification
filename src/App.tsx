import { useEffect, useState } from 'react'
import { useBench } from './bench/useBench.ts'
import ComparisonPanel from './components/compare/ComparisonPanel.tsx'
import { loadComparisonCharts } from './components/compare/loadCharts.ts'
import DatasetManager from './components/dataset/DatasetManager.tsx'
import DetailView from './components/detail/DetailView.tsx'
import { ControlBar } from './components/layout/ControlBar.tsx'
import { Header } from './components/layout/Header.tsx'
import { HowItWorks } from './components/layout/HowItWorks.tsx'
import { panelDomId, tabDomId } from './components/layout/labels.ts'
import { parseQuery, type TabId } from './components/layout/query.ts'
import { RunStatus } from './components/layout/RunStatus.tsx'
import { TabBar } from './components/layout/TabBar.tsx'
import { useAppTab } from './components/layout/useAppTab.ts'
import { useQueryBootstrap } from './components/layout/useQueryBootstrap.ts'
import { SplitView } from './components/lane/SplitView.tsx'
import QuickTest from './components/quick/QuickTest.tsx'
import { UI } from './components/ui/theme.ts'

function BenchmarkTab() {
  return (
    <div className="space-y-4">
      <ControlBar />
      <RunStatus />
      <SplitView />
      <ComparisonPanel />
    </div>
  )
}

function TabContent({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'benchmark':
      return <BenchmarkTab />
    case 'detalle':
      return <DetailView />
    case 'dataset':
      return <DatasetManager />
    case 'prueba':
      return <QuickTest />
  }
}

export default function App() {
  // The URL is read once: later changes only come from the app itself.
  const [query] = useState(() => parseQuery(window.location.search))
  const [tab, setTab] = useAppTab()
  const storageWarning = useBench((s) => s.storageWarning)
  useQueryBootstrap(query)
  // Prefetch the recharts chunk now, before any run can start (see loadCharts.ts). If it fails, the
  // error shows up when the charts render (React.lazy calls the loader again).
  useEffect(() => {
    loadComparisonCharts().catch(() => undefined)
  }, [])

  // Scroll containers of wide tables are `relative`: their sr-only spans (position: absolute) must be
  // clipped by them, not escape to the page and add a horizontal scroll on phones.
  return (
    <div className={UI.page}>
      <div className="mx-auto w-full max-w-[1600px] min-w-0 space-y-4 px-4 py-5 sm:px-6">
        <Header />
        <HowItWorks />
        {storageWarning && (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <span aria-hidden>⚠ </span>
            {storageWarning}
          </p>
        )}
        <TabBar active={tab} onChange={setTab} />
        <main role="tabpanel" id={panelDomId(tab)} aria-labelledby={tabDomId(tab)} tabIndex={-1} className="min-w-0 outline-none">
          <TabContent tab={tab} />
        </main>
      </div>
    </div>
  )
}
