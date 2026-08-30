/** Duracao curta e legivel de relance: `4m12s`, `1h07m`, `812ms`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatClock(iso: string | undefined): string {
  if (iso === undefined) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/** `2,4×` — o separador decimal segue a lingua do produto. */
export function formatRatio(value: number): string {
  return `${value.toFixed(1).replace('.', ',')}×`
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function elapsedSince(iso: string | undefined, now: number): number | undefined {
  if (iso === undefined) return undefined
  const at = new Date(iso).getTime()
  return Number.isNaN(at) ? undefined : Math.max(0, now - at)
}
