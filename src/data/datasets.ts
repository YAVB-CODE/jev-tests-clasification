/** Registro de datasets incluidos en la app (semilla). Los personalizados viven en storage.ts. */
import { SEED_DATASET_ID, type Dataset } from '../shared/contracts.ts'
import { PUC_COLOMBIA_DATASET } from './puc-colombia.ts'

export const SEED_DATASETS: readonly Dataset[] = [PUC_COLOMBIA_DATASET]

export const DEFAULT_DATASET_ID: string = SEED_DATASET_ID

export function getSeedDataset(id: string): Dataset | undefined {
  return SEED_DATASETS.find((dataset) => dataset.id === id)
}
