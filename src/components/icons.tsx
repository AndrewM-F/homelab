import type { JSX } from 'solid-js'

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
