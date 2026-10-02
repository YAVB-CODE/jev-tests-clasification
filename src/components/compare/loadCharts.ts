/**
 * Dynamic import of the recharts chunk. App.tsx calls it right after mount so the chunk is already in
 * the module cache when a run starts: fetching / parsing it mid-run would take a browser connection and
 * main-thread time away from the benchmark requests and inflate their measured latency.
 */
export const loadComparisonCharts = () => import('./ComparisonCharts.tsx')
