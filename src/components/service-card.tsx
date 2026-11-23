import { Show, type JSX } from 'solid-js'
import { publicUrl } from '../lib/inventory'
import type { Inventory, ProbeResult, Service } from '../lib/types'
import { CardMenu, type MenuItem } from './card-menu'
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

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (!isConnect()) items.push({ label: 'Open', href: href() })
    if (props.service.addresses?.tailnet) {
      items.push({ label: 'Copy tailnet', value: props.service.addresses.tailnet })
    }
    if (props.service.addresses?.lan) {
      items.push({ label: 'Copy LAN', value: props.service.addresses.lan })
    }
    if (!isConnect()) items.push({ label: 'Copy URL', copy: href() })
    if (isConnect() && props.service.connect?.command) {
      items.push({ label: 'Copy command', value: props.service.connect.command })
    }
    return items
  }

  const trailing = () =>
    isConnect() ? props.service.connect!.protocol.toUpperCase() : props.service.tags?.join(' · ')

  const body = (
    <>
      <header class="service-head">
        <Logo icon={props.service.icon} name={props.service.name} size="lg" />
        <div class="service-title">
          <h3>{props.service.name}</h3>
          <Show when={props.service.description}>
            <p class="service-desc">{props.service.description}</p>
          </Show>
        </div>
      </header>

      <footer class="service-foot">
        <span class="service-host">
          <span class={`dot ${state()}`} />
          {props.machineName}
        </span>
        <Show when={trailing()}>
          <span class="service-tags">{trailing()}</span>
        </Show>
      </footer>
    </>
  )

  return (
    <div class="card" classList={{ 'is-connect': isConnect(), 'is-down': state() === 'down' }}>
      <Show
        when={!isConnect()}
        fallback={<div class="service is-static">{body}</div>}
      >
        <a
          class="service"
          href={href()}
          target="_blank"
          rel="noreferrer noopener"
          title={href()}
          aria-label={`${props.service.name} — ${href()}`}
        >
          {body}
        </a>
      </Show>
      <CardMenu items={menuItems()} label={`${props.service.name} options`} />
    </div>
  )
}
