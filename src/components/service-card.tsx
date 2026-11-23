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
  /** Real running state of the host, used when the service itself has no probe. */
  machineOnline?: boolean
}

type Health = 'up' | 'down' | 'unknown'

function health(probe: ProbeResult | undefined): Health {
  if (!probe || probe.up === null) return 'unknown'
  return probe.up ? 'up' : 'down'
}

export function ServiceCard(props: Props): JSX.Element {
  // `url` wins when a service lives somewhere other than its own subdomain.
  const href = () => props.service.url ?? publicUrl(props.inventory, props.service)
  const state = () => {
    if (props.probe) return health(props.probe)
    // No probe of its own (a connect page): fall back to the host's real state.
    if (props.machineOnline !== undefined) return props.machineOnline ? 'up' : 'down'
    return 'unknown'
  }
  const isConnect = () => Boolean(props.service.connect)

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Open', href: href() }]
    if (props.service.addresses?.tailnet) {
      items.push({ label: 'Tailnet', value: props.service.addresses.tailnet })
    }
    if (props.service.addresses?.lan) {
      items.push({ label: 'LAN', value: props.service.addresses.lan })
    }
    items.push({ label: 'URL', value: href() })
    if (isConnect() && props.service.connect?.command) {
      items.push({ label: 'Command', value: props.service.connect.command })
    }
    return items
  }

  const trailing = () =>
    isConnect() ? props.service.connect!.protocol.toUpperCase() : props.service.tags?.join(' · ')

  const body = (
    <>
      <header class="service-head">
        <h3>{props.service.name}</h3>
        <Show when={props.service.description}>
          <p class="service-desc">{props.service.description}</p>
        </Show>
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

  const content = (
    <>
      <Logo icon={props.service.icon} name={props.service.name} size="rail" />
      <div class="service-body">{body}</div>
    </>
  )

  return (
    <div class="card" classList={{ 'is-connect': isConnect(), 'is-down': state() === 'down' }}>
      <a
        class="service"
        href={href()}
        target="_blank"
        rel="noreferrer noopener"
        title={href()}
        aria-label={`${props.service.name} — ${href()}`}
      >
        {content}
      </a>
      <CardMenu items={menuItems()} label={`${props.service.name} options`} />
    </div>
  )
}
