/** Browser download of generated text (Blob + object URL). */

/** UTF-8 byte order mark: makes Excel read accents correctly; the CSV importers strip it. */
const BOM = '\uFEFF'

export type DownloadKind = 'json' | 'csv'

const MIME: Record<DownloadKind, string> = {
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
}

export function downloadText(filename: string, content: string, kind: DownloadKind): void {
  const blob = new Blob([kind === 'csv' ? BOM + content : content], { type: MIME[kind] })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke after the click has been handled by the browser.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Safe file name stem from a dataset id. */
export function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset'
}
