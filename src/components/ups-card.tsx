import { Show, type JSX } from 'solid-js'
import { duration } from '../lib/format'
import type { UpsStat } from '../lib/types'
import { BoltIcon } from './icons'
import { Inline, Meter } from './meter'

/**
 * `mains` is the only quiet state; the other two exist to be noticed, so they
 * borrow the warning colours the meters already use.
 */
type UpsState = 'mains' | 'battery' | 'low' | 'unknown'

const LABELS: Record<UpsState, string> = {
  mains: 'on mains',
  battery: 'on battery',
  low: 'low battery',
  unknown: 'no data',
}

export function UpsCard(props: { ups?: UpsStat | null }): JSX.Element {
  const state = (): UpsState => {
    if (!props.ups) return 'unknown'
    if (props.ups.lowBattery) return 'low'
    if (props.ups.onBattery) return 'battery'
    return 'mains'
  }

  const name = () => [props.ups?.manufacturer, props.ups?.model].filter(Boolean).join(' ') || 'UPS'

  // Charge and load arrive as 0..100; the meters want 0..1.
  const chargeFraction = () => (props.ups?.charge ?? 0) / 100
  const loadFraction = () => (props.ups?.load ?? 0) / 100

  // Charge is the one meter that is unhealthy at the *bottom* of the scale.
  const chargeTone = () => {
    const charge = props.ups?.charge
    if (charge == null) return 'ok' as const
    if (charge <= 20) return 'bad' as const
    if (charge <= 50) return 'warn' as const
    return 'ok' as const
  }

  return (
    <article class={`ups-card is-${state()}`}>
      <header class="ups-head">
        <span class="ups-bolt">
          <BoltIcon size={15} />
        </span>
        <div class="ups-title">
          <h3 class="ups-name">{name()}</h3>
          <span class="ups-role">{props.ups?.name ?? 'no ups configured'}</span>
        </div>
        <span class={`chip is-${state()}`}>
          <span class="chip-dot" />
          {LABELS[state()]}
        </span>
      </header>

      <Show
        when={props.ups}
        fallback={<p class="ups-empty">NUT is not answering on this host, so the UPS state is unknown.</p>}
      >
        <div class="meter-stack">
          <Meter
            label="charge"
            value={chargeFraction()}
            tone={chargeTone()}
            display={props.ups?.charge != null ? `${Math.round(props.ups.charge)}%` : '—'}
          />
          <Meter
            label="load"
            value={loadFraction()}
            display={props.ups?.load != null ? `${Math.round(props.ups.load)}%` : '—'}
            note="of capacity"
          />
        </div>

        <Inline
          items={[
            {
              label: 'runtime',
              value: duration(props.ups?.runtime),
              title: 'Estimated runtime on battery',
            },
            {
              label: 'input',
              value: props.ups?.voltage != null ? `${Math.round(props.ups.voltage)} V` : '—',
              title: 'Input voltage',
            },
            { label: 'status', value: props.ups?.status || '—', title: 'Raw NUT status word' },
          ]}
        />
      </Show>
    </article>
  )
}
