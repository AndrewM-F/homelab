import { For, Show, type JSX } from 'solid-js'
import { percent, severity } from '../lib/format'

export function Meter(props: {
  label: string
  value: number
  /** Formatted value shown on the right, e.g. "41%" or "12.4 GB". */
  display: string
  /** Optional secondary note, e.g. total capacity. */
  note?: string
  /**
   * Overrides the traffic-light colouring. Utilisation is bad when high, but
   * some values (battery charge) are bad when low, so the caller decides.
   */
  tone?: 'ok' | 'warn' | 'bad'
}): JSX.Element {
  return (
    <div class="meter">
      <div class="meter-head">
        <span class="meter-label">{props.label}</span>
        <span class="meter-value">
          {props.display}
          <Show when={props.note}>
            <span class="meter-note">{props.note}</span>
          </Show>
        </span>
      </div>
      <div class="meter-track">
        <div
          class={`meter-fill is-${props.tone ?? severity(props.value)}`}
          style={{ width: `${Math.min(100, Math.max(0, props.value * 100))}%` }}
        />
      </div>
    </div>
  )
}

/** Compact inline stat used in card footers. */
export function Inline(props: { items: { label: string; value: string; title?: string }[] }): JSX.Element {
  return (
    <div class="inline-stats">
      <For each={props.items}>
        {(item) => (
          <span class="inline-stat" title={item.title}>
            <span class="inline-stat-label">{item.label}</span>
            <span class="inline-stat-value">{item.value}</span>
          </span>
        )}
      </For>
    </div>
  )
}

export function Trend(props: { values: number[]; max?: number }): JSX.Element {
  const ceiling = () => Math.max(props.max ?? 0.0001, ...props.values, 0.0001)
  return (
    <div class="trend" aria-hidden="true">
      <For each={props.values}>
        {(v) => <span class="trend-bar" style={{ height: `${Math.max(6, (v / ceiling()) * 100)}%` }} />}
      </For>
    </div>
  )
}

export function ring(fraction: number): string {
  return `conic-gradient(var(--accent) ${Math.round(fraction * 100)}%, var(--line-strong) 0)`
}

export function percentLabel(fraction: number): string {
  return percent(fraction)
}
