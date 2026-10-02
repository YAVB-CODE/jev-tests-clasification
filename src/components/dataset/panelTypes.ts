import type { Dataset } from '../../shared/contracts.ts'

/** Props shared by the dataset manager panels. */
export interface PanelProps {
  /** The dataset being shown: the saved one, or the unsaved working copy. */
  dataset: Dataset
  /** Custom dataset and no benchmark running. */
  editable: boolean
  /** Applies a change to the working copy (nothing is saved until the user confirms). */
  onChange: (update: (dataset: Dataset) => Dataset) => void
}
