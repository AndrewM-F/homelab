import { Show, type JSX } from 'solid-js'

const base = {
  width: '1em',
  height: '1em',
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.5,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  'aria-hidden': true as const,
}

export function ArrowOut(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <path d="M6 3h7v7" />
      <path d="M13 3 4 12" />
    </svg>
  )
}

export function SearchIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3 3" />
    </svg>
  )
}

export function RefreshIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <path d="M13.5 7a5.5 5.5 0 1 1-1.7-3.4" />
      <path d="M13.5 2v3.2H10.3" />
    </svg>
  )
}

export function LockIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
    </svg>
  )
}

export function TerminalIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m4.75 6.5 2 1.75-2 1.75" />
      <path d="M8.75 10.25h2.5" />
    </svg>
  )
}

/**
 * Battery gauge for the status line. `level` is 0..1 and drives the fill only;
 * the colour comes from the chip's state class, so one icon serves mains,
 * battery and low-battery without a second variant.
 */
export function BatteryIcon(props: { size?: number; level?: number }): JSX.Element {
  const width = () => 8.6 * Math.min(1, Math.max(0, props.level ?? 1))
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <rect x="1.6" y="4.2" width="11" height="7.6" rx="1.8" />
      <path d="M14.2 6.5v3" />
      <Show when={width() > 0.4}>
        <rect x="3" y="5.7" width={width()} height="4.6" rx="1.1" fill="currentColor" stroke="none" />
      </Show>
    </svg>
  )
}

export function ServerIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </svg>
  )
}

export function CubeIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <path d="M8 2.2 13.4 5v6L8 13.8 2.6 11V5z" />
      <path d="M2.6 5 8 7.8 13.4 5" />
      <path d="M8 7.8v6" />
    </svg>
  )
}

export function GridIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 13}px`, height: `${props.size ?? 13}px` }}>
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1" />
    </svg>
  )
}

export function CopyIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 4.5v5.5A1.5 1.5 0 0 0 3.5 11.5h1" />
    </svg>
  )
}

export function MoreIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 14}px`, height: `${props.size ?? 14}px` }}>
      <circle cx="3.25" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function CheckIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  )
}

export function DownloadIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <path d="M8 3v7" />
      <path d="m5 7.5 3 3 3-3" />
      <path d="M3.5 12.5h9" />
    </svg>
  )
}

export function UploadIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...base} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <path d="M8 12.5v-7" />
      <path d="m5 8 3-3 3 3" />
      <path d="M3.5 3.5h9" />
    </svg>
  )
}

/** The column switches: one framed layout per count, so the dividers are the only difference. */
const columns = {
  ...base,
  'stroke-width': 1.3,
}

export function ColumnsFourIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...columns} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <rect x="1.85" y="3.1" width="12.3" height="9.8" rx="1.7" />
      <path d="M4.925 3.1v9.8M8 3.1v9.8M11.075 3.1v9.8" />
    </svg>
  )
}

export function ColumnsThreeIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...columns} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <rect x="1.85" y="3.1" width="12.3" height="9.8" rx="1.7" />
      <path d="M5.95 3.1v9.8M10.05 3.1v9.8" />
    </svg>
  )
}

export function ColumnsTwoIcon(props: { size?: number }): JSX.Element {
  return (
    <svg {...columns} style={{ width: `${props.size ?? 12}px`, height: `${props.size ?? 12}px` }}>
      <rect x="1.85" y="3.1" width="12.3" height="9.8" rx="1.7" />
      <path d="M8 3.1v9.8" />
    </svg>
  )
}
