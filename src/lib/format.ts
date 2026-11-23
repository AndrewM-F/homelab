/** Small, dependency-free formatters. All output is compact by design. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function bytes(value: number | undefined | null, precision = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  let unit = 0
  let n = value
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  return `${n.toFixed(n >= 100 ? 0 : precision)} ${UNITS[unit]}`
}

export function rate(bytesPerSecond: number | undefined | null): string {
  if (bytesPerSecond === undefined || bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) {
    return '—'
  }
  return `${bytes(bytesPerSecond, 1)}/s`
}

export function percent(fraction: number | undefined | null, digits = 0): string {
  if (fraction === undefined || fraction === null || !Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

export function duration(seconds: number | undefined | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function clock(ts: number | undefined | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Clamps a 0..1 utilisation into the traffic-light banding used by the meters. */
export function severity(fraction: number): 'ok' | 'warn' | 'bad' {
  if (fraction >= 0.9) return 'bad'
  if (fraction >= 0.75) return 'warn'
  return 'ok'
}
