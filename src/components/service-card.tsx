import { Show, type JSX } from 'solid-js'
import { publicUrl } from '../lib/inventory'
import type { Inventory, ProbeResult, Service } from '../lib/types'
import { ArrowOut, TerminalIcon } from './icons'
import { Logo } from './logo'

interface Props {
  inventory: Inventory
  service: Service
  machineName: string
  probe?: ProbeResult
}

type Health = 'up' | 'down' | 'unknown'

function health(probe: ProbeResult | undefined): Health {
  if (!probe || probe.up === null) return 'unknown'
  return probe.up ? 'up' : 'down'
}

export function ServiceCard(props: Props): JSX.Element {
  const href = () => publicUrl(props.inventory, props.service)
  const state = () => health(props.probe)
  const isConnect = () => Boolean(props.service.connect)

  const body = (
    <>
      <header class="service-head">
        <Logo icon={props.service.icon} name={props.service.name} />
        <div class="service-title">
          <h3>{props.service.name}</h3>
          <Show when={props.service.description}>
            <p class="service-desc">{props.service.description}</p>
          </Show>
        </div>
        <span class="service-go" aria-hidden="true">
          <Show when={!isConnect()} fallback={<TerminalIcon />}>
            <ArrowOut />
          </Show>
        </span>
      </header>

      <footer class="service-foot">
        <span class="service-host">
          <span class={`dot ${state()}`} />
          {props.machineName}
        </span>
        <Show when={props.service.tags?.length}>
          <span class="service-tags">{props.service.tags!.join(' · ')}</span>
        </Show>
      </footer>
    </>
  )

  return (
    <Show
      when={!isConnect()}
      fallback={
        <div class="service is-connect" classList={{ 'is-down': state() === 'down' }}>
          {body}
        </div>
      }
    >
      <a
        class="service"
        classList={{ 'is-down': state() === 'down' }}
        href={href()}
        target="_blank"
        rel="noreferrer noopener"
        title={href()}
      >
        {body}
      </a>
    </Show>
  )
}
