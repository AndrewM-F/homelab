/** Small, dependency-free formatters. All output is compact by design. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function bytes(value: number | undefined | null, precision = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  // A terabyte is how drives are sold, so from 1 TB up the scale divides in
  // decimal: a 1 TB device reads "1 TB" instead of "932 GB", while a 96 GiB
  // volume below that still reads "96 GB".
  if (value >= 1e12) {
    const terabytes = value / 1e12
    return `${terabytes.toFixed(terabytes >= 100 ? 0 : precision)} TB`
  }
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
  // Pinned to UTC and labelled: the Worker renders this on the server, where the
  // timezone is UTC, so an unpinned clock showed one time in the server HTML and
  // another after hydration.
  return `${new Date(ts * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  })} UTC`
}

/** Clamps a 0..1 utilisation into the traffic-light banding used by the meters. */
export function severity(fraction: number): 'ok' | 'warn' | 'bad' {
  // Proxmox runs hot by design — page cache, ZFS ARC and guests that keep their
  // share resident — so 90% is a normal reading, not a fault. Red starts above it.
  if (fraction > 0.91) return 'bad'
  if (fraction >= 0.75) return 'warn'
  return 'ok'
}
