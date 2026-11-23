import type { JSX } from 'solid-js'
import { severity } from '../lib/format'

const RADIUS = 26
const STROKE = 5
const CENTER = 32
/** Length of a half circle: the dash maths is in arc units, not degrees. */
const ARC = Math.PI * RADIUS

interface Props {
  /** 0..1 */
  value: number
  /** Text inside the arc, e.g. "29%". */
  center: string
  label: string
  note?: string
}

/**
 * Semicircular resource gauge. The arc is one path with a dash offset, which
 * animates smoothly in CSS and needs no canvas or layout work.
 */
export function Gauge(props: Props): JSX.Element {
  const clamped = () => Math.min(1, Math.max(0, Number.isFinite(props.value) ? props.value : 0))
  const offset = () => ARC * (1 - clamped())

  return (
    <div class="gauge" title={`${props.label} ${props.center}${props.note ? ` · ${props.note}` : ''}`}>
      <svg class="gauge-frame" viewBox="0 0 64 38" role="img" aria-label={`${props.label} ${props.center}`}>
        <path
          class="gauge-track"
          d={`M ${CENTER - RADIUS} ${CENTER} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTER + RADIUS} ${CENTER}`}
          fill="none"
          stroke-width={STROKE}
          stroke-linecap="round"
        />
        <path
          class={`gauge-value is-${severity(clamped())}`}
          d={`M ${CENTER - RADIUS} ${CENTER} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTER + RADIUS} ${CENTER}`}
          fill="none"
          stroke-width={STROKE}
          stroke-linecap="round"
          stroke-dasharray={`${ARC} ${ARC}`}
          stroke-dashoffset={offset()}
        />
        <text class="gauge-center" x={CENTER} y={CENTER - 4} text-anchor="middle">
          {props.center}
        </text>
      </svg>
      <span class="gauge-label">{props.label}</span>
      {props.note ? <span class="gauge-note">{props.note}</span> : null}
    </div>
  )
}
