import { ENGINE_IDS } from '../../shared/contracts.ts'
import { LanePanel } from './LanePanel.tsx'

/** GPT on the left, Jev on the right (stacked on mobile). Same grid track widths for both lanes. */
export function SplitView() {
  return (
    <section aria-label="Pantalla dividida: GPT frente a Jev" className="grid gap-4 md:grid-cols-2">
      {ENGINE_IDS.map((id) => (
        <LanePanel key={id} engine={id} />
      ))}
    </section>
  )
}
