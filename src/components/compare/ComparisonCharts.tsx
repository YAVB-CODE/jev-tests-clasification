/**
 * The four comparison charts. The only module of the panel that imports recharts (~400 kB): it is
 * loaded on demand (React.lazy in ComparisonPanel) so the first paint does not wait for it.
 */
import type { LaneMetrics } from '../../metrics/index.ts'
import { DifficultyChart } from './DifficultyChart.tsx'
import { LatencyChart } from './LatencyChart.tsx'
import { ReliabilityChart } from './ReliabilityChart.tsx'
import { RiskCoverageChart } from './RiskCoverageChart.tsx'

export default function ComparisonCharts({ gpt, jev }: { gpt: LaneMetrics; jev: LaneMetrics }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ReliabilityChart gpt={gpt} jev={jev} />
      <LatencyChart gpt={gpt} jev={jev} />
      <DifficultyChart gpt={gpt} jev={jev} />
      <RiskCoverageChart gpt={gpt} jev={jev} />
    </div>
  )
}
